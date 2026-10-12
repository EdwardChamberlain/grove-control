const assert = require("node:assert/strict");
const test = require("node:test");
const { runRelease } = require("./create_github_release");

const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const PUBLISHER_RUN_ID = 42;

function notFound() {
  const error = new Error("Not Found");
  error.status = 404;
  return error;
}

function createHarness({
  tagCommit = null,
  release = null,
  publishConclusion = "success",
  publisherHeadSha = COMMIT,
  releaseCreateConflict = false,
} = {}) {
  const calls = [];
  let currentTagCommit = tagCommit;
  let currentRelease = release;
  const publisherRun = {
    id: PUBLISHER_RUN_ID,
    workflow_id: 8,
    event: "workflow_run",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: publisherHeadSha,
    head_repository: { full_name: "EdwardChamberlain/grove-control" },
  };
  const github = {
    rest: {
      actions: {
        async getWorkflowRun(args) {
          calls.push(["getWorkflowRun", args]);
          return { data: publisherRun };
        },
        async getWorkflow(args) {
          calls.push(["getWorkflow", args]);
          return {
            data: {
              name: "Docker Publish",
              path: ".github/workflows/docker-publish.yml",
            },
          };
        },
        async listJobsForWorkflowRun(args) {
          calls.push(["listJobsForWorkflowRun", args]);
          return {
            data: {
              jobs: [
                {
                  name: "Publish :latest and version tag",
                  conclusion: publishConclusion,
                  steps: [
                    { name: "Build and push production tags", conclusion: publishConclusion },
                    { name: "Upload deployed release metadata", conclusion: "success" },
                  ],
                },
              ],
            },
          };
        },
      },
      git: {
        async getRef(args) {
          calls.push(["getRef", args]);
          if (!currentTagCommit) throw notFound();
          return { data: { object: { type: "commit", sha: currentTagCommit } } };
        },
        async createRef(args) {
          calls.push(["createRef", args]);
          if (currentTagCommit) {
            const error = new Error("Reference already exists");
            error.status = 422;
            throw error;
          }
          currentTagCommit = args.sha;
          return { data: { ref: args.ref } };
        },
        async getTag(args) {
          calls.push(["getTag", args]);
          throw new Error("Unexpected annotated tag lookup");
        },
      },
      repos: {
        async getContent(args) {
          calls.push(["getContent", args]);
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from("1.0.0\n", "utf8").toString("base64"),
            },
          };
        },
        async generateReleaseNotes(args) {
          calls.push(["generateReleaseNotes", args]);
          return { data: { body: "## What's Changed\n- Add the feature" } };
        },
        async getReleaseByTag(args) {
          calls.push(["getReleaseByTag", args]);
          if (!currentRelease) throw notFound();
          return { data: currentRelease };
        },
        async createRelease(args) {
          calls.push(["createRelease", args]);
          if (releaseCreateConflict && !currentRelease) {
            currentRelease = { id: 501, tag_name: args.tag_name, body: "Created concurrently" };
            const error = new Error("Release already exists");
            error.status = 422;
            throw error;
          }
          currentRelease = { id: 501, tag_name: args.tag_name, body: args.body };
          return { data: currentRelease };
        },
        async updateRelease(args) {
          calls.push(["updateRelease", args]);
          currentRelease = { ...currentRelease, ...args, tag_name: "v1.0.0" };
          return { data: currentRelease };
        },
      },
    },
  };
  const core = {
    info(message) {
      calls.push(["info", message]);
    },
    notice(message) {
      calls.push(["notice", message]);
    },
  };
  const context = {
    eventName: "workflow_run",
    ref: "refs/heads/main",
    repo: { owner: "EdwardChamberlain", repo: "grove-control" },
    payload: { workflow_run: publisherRun },
  };

  return {
    calls,
    context,
    core,
    github,
    publisherRun,
    metadata: { commit: COMMIT, version: "1.0.0" },
    get tagCommit() {
      return currentTagCommit;
    },
    get release() {
      return currentRelease;
    },
  };
}

test("creates the v-prefixed source tag at the deployed image commit from publisher metadata", async () => {
  const harness = createHarness({ publisherHeadSha: OTHER_COMMIT });
  const result = await runRelease({
    github: harness.github,
    context: harness.context,
    core: harness.core,
    getHeadSha: () => COMMIT,
    readVersion: () => "1.0.0",
    readMetadata: () => harness.metadata,
  });

  assert.deepEqual(result, {
    tag: "v1.0.0",
    version: "1.0.0",
    commitSha: COMMIT,
    releaseId: 501,
    dryRun: false,
  });
  assert.equal(harness.tagCommit, COMMIT);
  assert.equal(harness.release.tag_name, "v1.0.0");
  assert.notEqual(harness.publisherRun.head_sha, result.commitSha);

  const createRef = harness.calls.find(([name]) => name === "createRef");
  assert.deepEqual(createRef[1], {
    owner: "EdwardChamberlain",
    repo: "grove-control",
    ref: "refs/tags/v1.0.0",
    sha: COMMIT,
  });
  const createRelease = harness.calls.find(([name]) => name === "createRelease");
  assert.equal(createRelease[1].target_commitish, COMMIT);
  assert.match(createRelease[1].body, new RegExp(COMMIT));
  assert.match(createRelease[1].body, /grove-control:1\.0\.0/);
  assert.match(createRelease[1].body, /UPDATING\.md#database-migrations/);
  assert.match(createRelease[1].body, /What's Changed/);
});

test("reuses a matching tag and updates an existing release on rerun", async () => {
  const harness = createHarness({
    tagCommit: COMMIT,
    release: { id: 501, tag_name: "v1.0.0", body: "Old generated notes" },
  });

  const result = await runRelease({
    github: harness.github,
    context: harness.context,
    core: harness.core,
    getHeadSha: () => COMMIT,
    readVersion: () => "1.0.0",
    readMetadata: () => harness.metadata,
  });

  assert.equal(result.releaseId, 501);
  assert.equal(harness.calls.some(([name]) => name === "createRef"), false);
  assert.equal(harness.calls.some(([name]) => name === "createRelease"), false);
  assert.equal(harness.calls.some(([name]) => name === "updateRelease"), true);
});

test("recovers when a prior run created the matching tag but not the release", async () => {
  const harness = createHarness({ tagCommit: COMMIT });

  const result = await runRelease({
    github: harness.github,
    context: harness.context,
    core: harness.core,
    getHeadSha: () => COMMIT,
    readVersion: () => "1.0.0",
    readMetadata: () => harness.metadata,
  });

  assert.equal(result.releaseId, 501);
  assert.equal(harness.calls.some(([name]) => name === "createRef"), false);
  assert.equal(harness.calls.some(([name]) => name === "createRelease"), true);
});

test("updates a release created concurrently instead of leaving a failed duplicate run", async () => {
  const harness = createHarness({ releaseCreateConflict: true });

  const result = await runRelease({
    github: harness.github,
    context: harness.context,
    core: harness.core,
    getHeadSha: () => COMMIT,
    readVersion: () => "1.0.0",
    readMetadata: () => harness.metadata,
  });

  assert.equal(result.releaseId, 501);
  assert.equal(harness.calls.some(([name]) => name === "createRelease"), true);
  assert.equal(harness.calls.some(([name]) => name === "updateRelease"), true);
});

test("fails without moving a tag that points at another commit", async () => {
  const harness = createHarness({ tagCommit: OTHER_COMMIT });

  await assert.rejects(
    runRelease({
      github: harness.github,
      context: harness.context,
      core: harness.core,
      getHeadSha: () => COMMIT,
      readVersion: () => "1.0.0",
      readMetadata: () => harness.metadata,
    }),
    /Refusing to move v1\.0\.0/,
  );
  assert.equal(harness.calls.some(([name]) => name === "createRef"), false);
  assert.equal(harness.calls.some(([name]) => name === "createRelease"), false);
});

test("does not mutate GitHub during a successful non-production dry run", async () => {
  const harness = createHarness();
  harness.publisherRun.head_sha = OTHER_COMMIT;
  harness.context.eventName = "workflow_dispatch";
  harness.context.payload = {};

  const result = await runRelease({
    github: harness.github,
    context: harness.context,
    core: harness.core,
    dryRun: true,
    workflowRunId: `${PUBLISHER_RUN_ID}`,
    readMetadata: () => harness.metadata,
  });

  assert.equal(result.dryRun, true);
  assert.equal(harness.calls.some(([name]) => name === "createRef"), false);
  assert.equal(harness.calls.some(([name]) => name === "createRelease"), false);
  assert.equal(harness.calls.some(([name]) => name === "updateRelease"), false);
  const versionLookup = harness.calls.find(([name]) => name === "getContent");
  assert.equal(versionLookup[1].ref, COMMIT);
});

test("refuses an unsuccessful publisher job even if the workflow run says success", async () => {
  const harness = createHarness({ publishConclusion: "skipped" });

  await assert.rejects(
    runRelease({
      github: harness.github,
      context: harness.context,
      core: harness.core,
      getHeadSha: () => COMMIT,
      readVersion: () => "1.0.0",
      readMetadata: () => harness.metadata,
    }),
    /Docker Publish job did not succeed/,
  );
  assert.equal(harness.calls.some(([name]) => name === "createRef"), false);
});

test("rejects prerelease or malformed versions", async () => {
  const harness = createHarness();

  await assert.rejects(
    runRelease({
      github: harness.github,
      context: harness.context,
      core: harness.core,
      getHeadSha: () => COMMIT,
      readVersion: () => "1.0.0-rc.1",
      readMetadata: () => ({ commit: COMMIT, version: "1.0.0-rc.1" }),
    }),
    /publisher artifact did not contain a stable X\.Y\.Z version/,
  );
  assert.equal(harness.calls.some(([name]) => name === "generateReleaseNotes"), false);
  assert.equal(harness.calls.some(([name]) => name === "createRef"), false);
});

test("rejects a publisher artifact version that does not match the deployed VERSION file", async () => {
  const harness = createHarness();

  await assert.rejects(
    runRelease({
      github: harness.github,
      context: harness.context,
      core: harness.core,
      getHeadSha: () => COMMIT,
      readVersion: () => "1.0.1",
      readMetadata: () => harness.metadata,
    }),
    /Docker Publish uploaded 1\.0\.0/,
  );
  assert.equal(harness.calls.some(([name]) => name === "generateReleaseNotes"), false);
  assert.equal(harness.calls.some(([name]) => name === "createRef"), false);
});

test("checks out the exact deployed commit before production writes", async () => {
  const harness = createHarness();

  await assert.rejects(
    runRelease({
      github: harness.github,
      context: harness.context,
      core: harness.core,
      getHeadSha: () => OTHER_COMMIT,
      readVersion: () => "1.0.0",
      readMetadata: () => harness.metadata,
    }),
    /but the published image used/,
  );
  assert.equal(harness.calls.some(([name]) => name === "generateReleaseNotes"), false);
  assert.equal(harness.calls.some(([name]) => name === "createRef"), false);
});
