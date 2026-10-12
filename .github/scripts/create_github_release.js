const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const RELEASE_TAG_PREFIX = "v";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const DOCKER_PUBLISH_WORKFLOW = ".github/workflows/docker-publish.yml";
const DOCKER_PUBLISH_JOB = "Publish :latest and version tag";
const DOCKER_PUBLISH_STEP = "Build and push production tags";
const RELEASE_METADATA_STEP = "Upload deployed release metadata";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isNotFound(error) {
  return error?.status === 404 || error?.statusCode === 404;
}

function ownerAndRepo(context) {
  const { owner, repo } = context.repo;
  assert(owner && repo, "The GitHub repository context is missing.");
  return { owner, repo, fullName: `${owner}/${repo}` };
}

async function getPublisherRun({ github, owner, repo, runId }) {
  const parsedRunId = Number(runId);
  assert(Number.isSafeInteger(parsedRunId) && parsedRunId > 0, "Provide a valid Docker Publish workflow run ID.");

  const { data } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: parsedRunId });
  return data;
}

async function verifyPublisherRun({ github, owner, repo, fullName, run }) {
  assert(run, "The Docker Publish workflow run is missing.");
  assert(run.event === "workflow_run", `Expected a workflow_run deployment, received ${run.event || "no event"}.`);
  assert(run.head_branch === "main", `Expected a main deployment, received ${run.head_branch || "no branch"}.`);
  assert(run.status === "completed" && run.conclusion === "success", "Docker Publish did not complete successfully.");
  assert(COMMIT_PATTERN.test(run.head_sha || ""), "Docker Publish did not provide a valid workflow run SHA.");
  assert(run.workflow_id, "Docker Publish did not provide a workflow ID.");

  const sourceRepository = run.head_repository?.full_name || run.repository?.full_name;
  assert(sourceRepository === fullName, `Docker Publish must deploy this repository, received ${sourceRepository || "no repository"}.`);

  const { data: workflow } = await github.rest.actions.getWorkflow({
    owner,
    repo,
    workflow_id: run.workflow_id,
  });
  assert(workflow.name === "Docker Publish", `Unexpected publisher workflow name: ${workflow.name || "missing"}.`);
  assert(workflow.path === DOCKER_PUBLISH_WORKFLOW, `Unexpected publisher workflow file: ${workflow.path || "missing"}.`);

  const { data: jobsResult } = await github.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: run.id,
    per_page: 100,
  });
  const publisherJob = (jobsResult.jobs || []).find((job) => job.name === DOCKER_PUBLISH_JOB);
  assert(publisherJob, `The expected Docker Publish job "${DOCKER_PUBLISH_JOB}" did not run.`);
  assert(publisherJob.conclusion === "success", "The Docker Publish job did not succeed.");

  const imagePushStep = (publisherJob.steps || []).find((step) => step.name === DOCKER_PUBLISH_STEP);
  assert(imagePushStep, `The expected GHCR publication step "${DOCKER_PUBLISH_STEP}" did not run.`);
  assert(imagePushStep.conclusion === "success", "The GHCR image publication step did not succeed.");

  const metadataStep = (publisherJob.steps || []).find((step) => step.name === RELEASE_METADATA_STEP);
  assert(metadataStep, `The expected release metadata step "${RELEASE_METADATA_STEP}" did not run.`);
  assert(metadataStep.conclusion === "success", "The stable release metadata artifact was not uploaded.");

  return run;
}

async function getTagCommit({ github, owner, repo, tag }) {
  let response;
  try {
    response = await github.rest.git.getRef({ owner, repo, ref: `tags/${tag}` });
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }

  let object = response.data.object;
  const visited = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    assert(object?.sha && object?.type, `Git tag ${tag} points to an invalid Git object.`);
    if (object.type === "commit") {
      return object.sha;
    }
    assert(object.type === "tag", `Git tag ${tag} points to unsupported object type ${object.type}.`);
    assert(!visited.has(object.sha), `Git tag ${tag} contains a tag-object cycle.`);
    visited.add(object.sha);
    const { data: annotatedTag } = await github.rest.git.getTag({ owner, repo, tag_sha: object.sha });
    object = annotatedTag.object;
  }

  throw new Error(`Git tag ${tag} is nested too deeply to resolve safely.`);
}

async function getReleaseByTag({ github, owner, repo, tag }) {
  try {
    const { data } = await github.rest.repos.getReleaseByTag({ owner, repo, tag });
    return data;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

async function readVersionAtCommit({ github, owner, repo, commitSha }) {
  const { data } = await github.rest.repos.getContent({
    owner,
    repo,
    path: "VERSION",
    ref: commitSha,
  });
  assert(data.type === "file" && data.content, `VERSION was not found at deployed commit ${commitSha}.`);
  return Buffer.from(data.content, data.encoding || "base64").toString("utf8").trim();
}

function readDeploymentMetadata(metadataPath = process.env.RELEASE_METADATA_PATH || ".release-metadata/stable-release.json") {
  return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
}

function buildReleaseBody({ owner, repo, tag, version, commitSha, generatedNotes }) {
  const image = `ghcr.io/${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const commitUrl = `https://github.com/${owner}/${repo}/commit/${commitSha}`;
  const updatingUrl = `https://github.com/${owner}/${repo}/blob/${tag}/UPDATING.md`;

  return [
    `Grove Control ${version} was deployed from commit [${commitSha}](${commitUrl}).`,
    `Stable container images: \`${image}:latest\` and \`${image}:${version}\`.`,
    "",
    "## Upgrade and migration guidance",
    `Before upgrading, create and retain a verified backup. Follow [UPDATING.md](<${updatingUrl}#before-you-upgrade>) for the supported upgrade steps.`,
    `Database migrations run automatically at startup; keep the backup until the service and data are verified. See [database migration guidance](<${updatingUrl}#database-migrations>).`,
    "",
    "## Changes",
    generatedNotes || "No generated release notes were returned.",
    "",
  ].join("\n");
}

async function ensureReleaseTag({ github, owner, repo, tag, commitSha }) {
  const currentCommit = await getTagCommit({ github, owner, repo, tag });
  if (currentCommit) {
    assert(
      currentCommit === commitSha,
      `Refusing to move ${tag}: it already points to ${currentCommit}, not deployed commit ${commitSha}.`,
    );
    return false;
  }

  try {
    await github.rest.git.createRef({
      owner,
      repo,
      ref: `refs/tags/${tag}`,
      sha: commitSha,
    });
  } catch (error) {
    if (error?.status !== 409 && error?.status !== 422 && error?.statusCode !== 409 && error?.statusCode !== 422) {
      throw error;
    }

    const concurrentCommit = await getTagCommit({ github, owner, repo, tag });
    assert(
      concurrentCommit === commitSha,
      `Refusing to move ${tag}: a concurrent tag points to ${concurrentCommit || "an unknown commit"}, not ${commitSha}.`,
    );
    return false;
  }

  const createdCommit = await getTagCommit({ github, owner, repo, tag });
  assert(createdCommit === commitSha, `Created tag ${tag} did not resolve to deployed commit ${commitSha}.`);
  return true;
}

async function updateRelease({ github, owner, repo, release, tag, version, body }) {
  assert(release.tag_name === tag, `Release lookup for ${tag} returned ${release.tag_name}.`);
  const { data } = await github.rest.repos.updateRelease({
    owner,
    repo,
    release_id: release.id,
    name: `Grove Control ${version}`,
    body,
    draft: false,
    prerelease: false,
  });
  return data;
}

function isConflict(error) {
  return error?.status === 409 || error?.status === 422 || error?.statusCode === 409 || error?.statusCode === 422;
}

async function runRelease({
  github,
  context,
  core,
  dryRun = false,
  workflowRunId,
  getHeadSha = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  readVersion = () => fs.readFileSync("VERSION", "utf8").trim(),
  readDeployedVersion = (commitSha) => readVersionAtCommit({ github, ...ownerAndRepo(context), commitSha }),
  readMetadata = () => readDeploymentMetadata(),
}) {
  const { owner, repo, fullName } = ownerAndRepo(context);
  let publisherRun;

  if (dryRun) {
    assert(context.eventName === "workflow_dispatch", "Dry-run mode is only available from workflow_dispatch.");
    assert(context.ref === "refs/heads/main", "Run the release dry run from main.");
    publisherRun = await getPublisherRun({ github, owner, repo, runId: workflowRunId });
  } else {
    assert(context.eventName === "workflow_run", "Stable releases must follow a completed Docker Publish workflow.");
    publisherRun = context.payload.workflow_run;
  }

  await verifyPublisherRun({ github, owner, repo, fullName, run: publisherRun });

  const deployment = readMetadata();
  const deployedSha = (deployment.commit || "").toLowerCase();
  const deployedVersion = deployment.version || "";
  assert(COMMIT_PATTERN.test(deployedSha), "The publisher artifact did not contain a valid deployed commit SHA.");
  assert(VERSION_PATTERN.test(deployedVersion), `The publisher artifact did not contain a stable X.Y.Z version; got: ${deployedVersion || "empty"}.`);

  if (!dryRun) {
    const checkedOutSha = getHeadSha().toLowerCase();
    assert(
      checkedOutSha === deployedSha,
      `Checked out ${checkedOutSha}, but the published image used ${deployedSha}.`,
    );
  }

  const version = dryRun ? await readDeployedVersion(deployedSha) : readVersion();
  assert(VERSION_PATTERN.test(version), `VERSION must contain a stable X.Y.Z version; got: ${version || "empty"}.`);
  assert(version === deployedVersion, `VERSION at deployed commit is ${version}, but Docker Publish uploaded ${deployedVersion}.`);
  const tag = `${RELEASE_TAG_PREFIX}${version}`;

  const existingTagCommit = await getTagCommit({ github, owner, repo, tag });
  assert(
    !existingTagCommit || existingTagCommit === deployedSha,
    `Refusing to move ${tag}: it already points to ${existingTagCommit}, not deployed commit ${deployedSha}.`,
  );

  const { data: notes } = await github.rest.repos.generateReleaseNotes({
    owner,
    repo,
    tag_name: tag,
    target_commitish: deployedSha,
  });
  const body = buildReleaseBody({
    owner,
    repo,
    tag,
    version,
    commitSha: deployedSha,
    generatedNotes: notes.body,
  });
  const existingRelease = await getReleaseByTag({ github, owner, repo, tag });

  core.info(`Docker Publish run ${publisherRun.id} published ${version} from ${deployedSha}.`);
  core.info(`Git source tag: ${tag}; stable GHCR tags: latest and ${version}.`);

  if (dryRun) {
    core.notice(`DRY RUN: would ${existingRelease ? "update" : "create"} GitHub Release ${tag}; no Git tag or release was changed.`);
    core.info(body);
    return { tag, version, commitSha: deployedSha, dryRun: true };
  }

  const tagCreated = await ensureReleaseTag({ github, owner, repo, tag, commitSha: deployedSha });
  if (tagCreated) {
    core.info(`Created lightweight Git tag ${tag} at ${deployedSha}.`);
  } else {
    core.info(`Reusing ${tag}, already pointing to ${deployedSha}.`);
  }

  let release;
  if (existingRelease) {
    release = await updateRelease({ github, owner, repo, release: existingRelease, tag, version, body });
  } else {
    try {
      const { data } = await github.rest.repos.createRelease({
        owner,
        repo,
        tag_name: tag,
        target_commitish: deployedSha,
        name: `Grove Control ${version}`,
        body,
        draft: false,
        prerelease: false,
        generate_release_notes: false,
      });
      release = data;
    } catch (error) {
      if (!isConflict(error)) {
        throw error;
      }
      const concurrentRelease = await getReleaseByTag({ github, owner, repo, tag });
      if (!concurrentRelease) {
        throw error;
      }
      release = await updateRelease({ github, owner, repo, release: concurrentRelease, tag, version, body });
    }
  }

  assert(release.tag_name === tag, `GitHub Release points to ${release.tag_name}, expected ${tag}.`);
  const releaseTagCommit = await getTagCommit({ github, owner, repo, tag });
  assert(
    releaseTagCommit === deployedSha,
    `GitHub Release ${tag} resolves to ${releaseTagCommit}, not deployed commit ${deployedSha}.`,
  );

  core.notice(`Published GitHub Release ${tag} for deployed commit ${deployedSha}.`);
  return { tag, version, commitSha: deployedSha, releaseId: release.id, dryRun: false };
}

module.exports = {
  buildReleaseBody,
  getPublisherRun,
  isConflict,
  readDeploymentMetadata,
  readVersionAtCommit,
  getTagCommit,
  runRelease,
  verifyPublisherRun,
};
