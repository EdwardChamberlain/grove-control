/**
 * ModelViewer with only the WebGL renderer and orbit controls stubbed:
 * 3MF parsing (inline meshes, external components, per-part extruders,
 * plate assignment), STL loading, colours, and the error states.
 *
 * The stub renderer keeps the last scene it was asked to draw, so tests
 * can inspect the meshes the real parsing and geometry code produced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import JSZip from 'jszip';
import * as THREE from 'three';
import { server } from '../mocks/server';

const state: { scene: THREE.Scene | null; camera: THREE.PerspectiveCamera | null } = { scene: null, camera: null };

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeRenderer {
    domElement = document.createElement('canvas');
    setSize = vi.fn();
    setPixelRatio = vi.fn();
    dispose = vi.fn();
    render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
      state.scene = scene;
      state.camera = camera;
    }
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

vi.mock('three/examples/jsm/controls/OrbitControls.js', async () => {
  const { Vector3 } = await vi.importActual<typeof import('three')>('three');
  class FakeControls {
    target = new Vector3();
    enableDamping = false;
    dampingFactor = 0;
    update = vi.fn();
    dispose = vi.fn();
  }
  return { OrbitControls: FakeControls };
});

const { ModelViewer } = await import('../../components/ModelViewer');

// Callers pass a stable object (it comes from query data); a fresh literal per render would re-run the setup effect.
const VOLUME = { x: 256, y: 256, z: 256 };

const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';

function cubeMesh(size = 10) {
  const s = size;
  const verts = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ].map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
  const tris = [[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7]]
    .map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
  return `<mesh><vertices>${verts}</vertices><triangles>${tris}</triangles></mesh>`;
}

async function make3mf(files: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'arraybuffer' });
}

/** A Bambu-style project: object 1 is two coloured parts in external files on plate 1, object 2 is inline on plate 2. */
async function bambuProject() {
  return make3mf({
    '3D/3dmodel.model': `<?xml version="1.0"?><model ${NS}><resources>
      <object id="1" type="model"><components>
        <component p:path="/3D/Objects/part_a.model" objectid="10" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>
        <component p:path="/3D/Objects/part_b.model" objectid="11"/>
        <component p:path="/3D/Objects/missing.model" objectid="12"/>
      </components></object>
      <object id="2" type="model" p:extruder="3">${cubeMesh(4)}</object>
      <object id="3" type="model"></object>
      <object type="model">${cubeMesh()}</object>
    </resources><build>
      <item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 0"/>
      <item objectid="2" transform="1 0 0 0 1 0 0 0 1 20 20 0"/>
      <item/>
    </build></model>`,
    '3D/Objects/part_a.model': `<model ${NS}><resources><object id="10">${cubeMesh()}</object></resources></model>`,
    '3D/Objects/part_b.model': `<model ${NS}><resources><object id="11">${cubeMesh()}</object></resources></model>`,
    'Metadata/model_settings.config': `<?xml version="1.0"?><config>
      <object id="1"><metadata key="name" value="Gift box"/><metadata key="extruder" value="1"/>
        <part id="10"><metadata key="extruder" value="2"/></part>
        <part id="11"/>
      </object>
      <object id="2"><metadata key="name" value="Lid"/></object>
      <plate><metadata key="plater_id" value="1"/><metadata key="pos_x" value="0"/>
        <model_instance><metadata key="object_id" value="1"/></model_instance></plate>
      <plate><metadata key="plater_id" value="2"/><metadata key="pos_x" value="300"/><metadata key="pos_y" value="12.5"/>
        <model_instance><metadata key="object_id" value="2"/></model_instance></plate>
      <plate><metadata key="pos_x" value="1"/></plate>
    </config>`,
    'Metadata/plate_1.json': JSON.stringify({ bbox_objects: [{ name: 'Gift box' }], bbox_all: [95, 95, 120, 110] }),
    'Metadata/plate_9.json': '{not json',
  });
}

function meshes(): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  state.scene?.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshPhongMaterial) found.push(child);
  });
  return found;
}

function colours(): string[] {
  return meshes().map((m) => `#${(m.material as THREE.MeshPhongMaterial).color.getHexString()}`).sort();
}

function serve(body: ArrayBuffer | string, status = 200) {
  server.use(http.get('/api/v1/model/:name', () => new HttpResponse(body, { status })));
}

async function loaded() {
  await waitFor(() => expect(document.querySelector('.animate-spin')).toBeNull());
}

let originalRaf: typeof window.requestAnimationFrame;
let originalCaf: typeof window.cancelAnimationFrame;

beforeEach(() => {
  state.scene = null;
  originalRaf = window.requestAnimationFrame;
  originalCaf = window.cancelAnimationFrame;
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  // Put back only what this file replaced; unstubAllGlobals would also drop the setup file's stubs.
  window.requestAnimationFrame = originalRaf;
  window.cancelAnimationFrame = originalCaf;
});

describe('3MF projects', () => {
  it('merges parts by extruder and colours them', async () => {
    serve(await bambuProject());
    render(<ModelViewer buildVolume={VOLUME} url="/api/v1/model/box.3mf" filamentColors={['#ff0000', '#00ff00', '#0000ff']} />);

    await loaded();
    // Extruder 1 (part 11), extruder 2 (part 10, per-part override), extruder 3 (object 2's attribute).
    expect(colours()).toEqual(['#0000ff', '#00ff00', '#ff0000']);
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('shows only the selected plate, positioned by its bounds or offset', async () => {
    serve(await bambuProject());
    const { rerender } = render(<ModelViewer buildVolume={VOLUME} url="/api/v1/model/box.3mf" selectedPlateId={1} />);

    await loaded();
    expect(meshes()).toHaveLength(2);

    rerender(<ModelViewer buildVolume={VOLUME} url="/api/v1/model/box.3mf" selectedPlateId={2} />);
    await waitFor(() => expect(meshes()).toHaveLength(1));

    // A plate with no items falls back to showing everything.
    rerender(<ModelViewer buildVolume={VOLUME} url="/api/v1/model/box.3mf" selectedPlateId={7} />);
    await waitFor(() => expect(meshes()).toHaveLength(3));
  });

  it('falls back to any .model file when there is no 3dmodel.model', async () => {
    serve(await make3mf({ 'Objects/thing.model': `<model ${NS}><resources><object id="1">${cubeMesh()}</object></resources></model>` }));
    render(<ModelViewer buildVolume={VOLUME} url="/api/v1/model/thing.3mf" filamentColors={['#123456']} />);

    await loaded();
    expect(colours()).toEqual(['#123456']);
  });

  it('places objects without a build section as-is', async () => {
    serve(await make3mf({ '3D/3dmodel.model': `<model ${NS}><resources><object id="1">${cubeMesh()}</object></resources></model>` }));
    render(<ModelViewer buildVolume={VOLUME} url="/api/v1/model/plain.3mf" />);

    await loaded();
    expect(colours()).toEqual(['#00ae42']);
  });

  it.each([
    ['no meshes', () => make3mf({ '3D/3dmodel.model': `<model ${NS}><resources><object id="1"/></resources></model>` }), 'No meshes found in 3MF file'],
    ['no model at all', () => make3mf({ 'readme.txt': 'hi' }), 'No meshes found in 3MF file'],
    ['not a zip', async () => 'definitely not a zip', 'Unsupported file format'],
  ])('reports %s', async (_, body, message) => {
    serve(await body());
    render(<ModelViewer buildVolume={VOLUME} url="/api/v1/model/bad.3mf" />);

    expect(await screen.findByText(message)).toBeInTheDocument();
  });
});

describe('other formats and controls', () => {
  it('loads an STL', async () => {
    const triangle = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid t\n';
    serve(triangle);
    render(<ModelViewer buildVolume={VOLUME} url="/api/v1/model/part.stl?v=2" filamentColors={['#abcdef']} />);

    await loaded();
    expect(colours()).toEqual(['#abcdef']);
  });

  it.each([['3mf'], ['stl']])('reports a failed %s download', async (type) => {
    serve('nope', 500);
    render(<ModelViewer buildVolume={VOLUME} url={`/api/v1/model/x.${type}`} />);

    expect(await screen.findByText('Failed to load file')).toBeInTheDocument();
  });

  it('rejects unsupported formats', async () => {
    render(<ModelViewer buildVolume={VOLUME} url="/api/v1/model/x.step" />);

    expect(await screen.findByText('Unsupported file format')).toBeInTheDocument();
  });

  it('zooms and resets the camera', async () => {
    serve(await bambuProject());
    const user = userEvent.setup();
    const { unmount } = render(<ModelViewer buildVolume={VOLUME} url="/api/v1/model/box.3mf" fileType="3MF" />);

    await loaded();
    const [zoomIn, zoomOut, reset] = screen.getAllByRole('button');
    const before = state.camera!.position.length();
    await user.click(zoomIn);
    expect(state.camera!.position.length()).toBeCloseTo(before * 0.8);
    await user.click(zoomOut);
    expect(state.camera!.position.length()).toBeCloseTo(before);
    await user.click(reset);
    expect(state.camera!.position.toArray()).toEqual([150, 150, 150]);

    window.dispatchEvent(new Event('resize'));
    unmount();
  });
});
