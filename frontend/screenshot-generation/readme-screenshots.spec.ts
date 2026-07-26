import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { stubWebSocket } from '../e2e/mockWebSocket';

const CAMERA_PLACEHOLDER = fileURLToPath(
  new URL('../public/img/camera_placeholder.png', import.meta.url),
);
const COCKPIT_SCREENSHOT = fileURLToPath(
  new URL('../../docs/screenshots/printers-cockpit.png', import.meta.url),
);
const LIST_SCREENSHOT = fileURLToPath(
  new URL('../../docs/screenshots/printers-list.png', import.meta.url),
);
const HEALTH_SCREENSHOT = fileURLToPath(
  new URL('../../docs/screenshots/printer-health.png', import.meta.url),
);
const PRINT_MODAL_SCREENSHOT = fileURLToPath(
  new URL('../../docs/screenshots/print-modal.png', import.meta.url),
);
const KIOSK_SCREENSHOT = fileURLToPath(
  new URL('../../docs/screenshots/kiosk-mode.png', import.meta.url),
);

const printers = [
  {
    id: 1,
    name: 'Workshop X1C',
    serial_number: '00M09A123456789',
    ip_address: '192.168.1.50',
    access_code: '12345678',
    model: 'X1C',
    location: 'Workshop',
    nozzle_count: 1,
    is_active: true,
    auto_archive: true,
    external_camera_url: null,
    external_camera_type: null,
    external_camera_enabled: false,
    external_camera_snapshot_url: null,
    camera_rotation: 0,
    plate_detection_enabled: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 2,
    name: 'Prototype P1S',
    serial_number: '01P00A123456789',
    ip_address: '192.168.1.51',
    access_code: '12345678',
    model: 'P1S',
    location: 'Design Studio',
    nozzle_count: 1,
    is_active: true,
    auto_archive: true,
    external_camera_url: null,
    external_camera_type: null,
    external_camera_enabled: false,
    external_camera_snapshot_url: null,
    camera_rotation: 0,
    plate_detection_enabled: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 3,
    name: 'Production A1',
    serial_number: '01S00A123456789',
    ip_address: '192.168.1.52',
    access_code: '12345678',
    model: 'A1',
    location: 'Production',
    nozzle_count: 1,
    is_active: true,
    auto_archive: true,
    external_camera_url: null,
    external_camera_type: null,
    external_camera_enabled: false,
    external_camera_snapshot_url: null,
    camera_rotation: 0,
    plate_detection_enabled: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

function filamentTray(
  id: number,
  material: string,
  name: string,
  colour: string,
  remaining: number,
) {
  return {
    id,
    tray_color: colour,
    tray_type: material,
    tray_sub_brands: name,
    tray_id_name: null,
    tray_info_idx: null,
    remain: remaining,
    k: 0.02,
    cali_idx: 0,
    tag_uid: null,
    tray_uuid: null,
    nozzle_temp_min: 190,
    nozzle_temp_max: 240,
    drying_temp: 55,
    drying_time: 8,
    state: 10,
  };
}

function emptyTray(id: number) {
  return {
    id,
    tray_color: null,
    tray_type: null,
    tray_sub_brands: null,
    tray_id_name: null,
    tray_info_idx: null,
    remain: 0,
    k: null,
    cali_idx: null,
    tag_uid: null,
    tray_uuid: null,
    nozzle_temp_min: null,
    nozzle_temp_max: null,
    drying_temp: null,
    drying_time: null,
    state: 9,
  };
}

function baseStatus(id: number, name: string) {
  return {
    id,
    name,
    connected: true,
    state: 'IDLE',
    current_print: null,
    subtask_name: null,
    current_archive_id: null,
    current_plate_id: null,
    gcode_file: null,
    progress: 0,
    remaining_time: 0,
    layer_num: 0,
    total_layers: 0,
    temperatures: {
      bed: 27,
      bed_target: 0,
      bed_heating: false,
      nozzle: 28,
      nozzle_target: 0,
      nozzle_heating: false,
      chamber: 27,
      chamber_target: 0,
      chamber_heating: false,
    },
    cover_url: null,
    hms_errors: [],
    ams: [],
    ams_exists: false,
    vt_tray: [],
    store_to_sdcard: true,
    timelapse: false,
    ipcam: true,
    wifi_signal: -45,
    wired_network: false,
    door_open: false,
    nozzles: [{ nozzle_type: 'hardened_steel', nozzle_diameter: '0.4' }],
    nozzle_rack: [],
    print_options: null,
    stg_cur: -1,
    stg_cur_name: null,
    stg: [],
    airduct_mode: 0,
    speed_level: 2,
    chamber_light: true,
    active_extruder: 0,
    ams_mapping: [],
    ams_extruder_map: {},
    fila_switch: null,
    tray_now: 255,
    ams_status_main: 0,
    ams_status_sub: 0,
    mc_print_sub_stage: 0,
    last_ams_update: 1_788_871_600,
    printable_objects_count: 1,
    cooling_fan_speed: 0,
    big_fan1_speed: 0,
    big_fan2_speed: 0,
    heatbreak_fan_speed: 0,
    firmware_version: '01.09.00.00',
    developer_mode: true,
    ams_filament_backup: true,
    awaiting_plate_clear: false,
    supports_drying: false,
    supports_chamber_heater: false,
  };
}

const printerStatuses = {
  1: {
    ...baseStatus(1, printers[0].name),
    state: 'RUNNING',
    current_print: 'Modular_Planter.3mf',
    subtask_name: 'Modular Planter',
    gcode_file: 'Modular_Planter.gcode.3mf',
    progress: 68,
    remaining_time: 47,
    layer_num: 186,
    total_layers: 274,
    temperatures: {
      bed: 60,
      bed_target: 60,
      bed_heating: true,
      nozzle: 220,
      nozzle_target: 220,
      nozzle_heating: true,
      chamber: 34,
      chamber_target: 0,
      chamber_heating: false,
    },
    ams: [
      {
        id: 0,
        humidity: 38,
        temp: 29.4,
        is_ams_ht: false,
        tray: [
          filamentTray(0, 'PLA', 'PLA Basic', '#00AE42', 82),
          filamentTray(1, 'PLA', 'PLA Matte', '#F5F1E8', 64),
          emptyTray(2),
          filamentTray(3, 'PETG', 'PETG HF', '#2D6CDF', 91),
        ],
        serial_number: 'AMS000000000001',
        sw_ver: '00.00.06.49',
        dry_time: 0,
        dry_status: 0,
        dry_sub_status: 0,
        dry_sf_reason: [],
        dry_target_temp: null,
        dry_filament: null,
        module_type: 'ams',
      },
    ],
    ams_exists: true,
    tray_now: 0,
    ams_mapping: [0],
    ams_extruder_map: { 0: 0 },
    cooling_fan_speed: 74,
    big_fan1_speed: 48,
    big_fan2_speed: 32,
    heatbreak_fan_speed: 100,
    supports_drying: true,
  },
  2: {
    ...baseStatus(2, printers[1].name),
    state: 'PAUSE',
    current_print: 'Enclosure_Bracket.3mf',
    subtask_name: 'Enclosure Bracket',
    gcode_file: 'Enclosure_Bracket.gcode.3mf',
    progress: 31,
    remaining_time: 95,
    layer_num: 74,
    total_layers: 238,
    temperatures: {
      bed: 55,
      bed_target: 55,
      bed_heating: true,
      nozzle: 220,
      nozzle_target: 220,
      nozzle_heating: true,
      chamber: 31,
      chamber_target: 0,
      chamber_heating: false,
    },
  },
  3: baseStatus(3, printers[2].name),
};

const archive = {
  id: 101,
  printer_id: 1,
  project_id: null,
  project_name: null,
  filename: 'modular-storage-drawer.gcode.3mf',
  file_path: 'archive/modular-storage-drawer.gcode.3mf',
  file_size: 8_462_336,
  content_hash: 'readme-screenshot-fixture',
  thumbnail_path: null,
  timelapse_path: null,
  source_3mf_path: null,
  f3d_path: null,
  duplicates: [],
  duplicate_count: 0,
  duplicate_sequence: 0,
  original_archive_id: null,
  object_count: 1,
  print_name: 'Modular Storage Drawer',
  print_time_seconds: 7_800,
  actual_time_seconds: 7_620,
  time_accuracy: 102,
  filament_used_grams: 118,
  filament_type: 'PLA',
  filament_color: '#00AE42',
  layer_height: 0.2,
  total_layers: 274,
  nozzle_diameter: 0.4,
  bed_temperature: 60,
  bed_type: 'Textured PEI Plate',
  nozzle_temperature: 220,
  sliced_for_model: 'X1C',
  status: 'completed',
  started_at: '2026-06-30T09:00:00Z',
  completed_at: '2026-06-30T11:07:00Z',
  extra_data: null,
  makerworld_url: null,
  designer: null,
  external_url: null,
  is_favorite: true,
  tags: 'workshop,storage',
  notes: null,
  cost: 2.36,
  photos: null,
  failure_reason: null,
  quantity: 1,
  energy_kwh: 0.48,
  energy_cost: 0.14,
  created_at: '2026-06-30T09:00:00Z',
  created_by_id: null,
  created_by_username: 'Morgan',
  run_count: 3,
  last_run_at: '2026-06-30T11:07:00Z',
  total_filament_actual_grams: 351,
  successful_run_count: 3,
  failed_run_count: 0,
};

const queueItems = [
  {
    id: 1,
    archive_id: 101,
    archive_name: 'Modular Planter',
    archive_thumbnail: null,
    library_file_id: null,
    printer_id: 1,
    printer_name: printers[0].name,
    target_model: null,
    target_location: null,
    status: 'printing',
    position: 1,
    scheduled_time: null,
    started_at: '2026-07-01T12:55:00Z',
    dispatched_at: '2026-07-01T12:54:00Z',
    completed_at: null,
    print_time_seconds: 7_800,
    filament_used_grams: 118,
    created_by_username: 'Morgan',
    waiting_reason: null,
    manual_start: false,
    batch_id: null,
    batch_name: null,
  },
  {
    id: 2,
    archive_id: 102,
    archive_name: 'Enclosure Bracket',
    archive_thumbnail: null,
    library_file_id: null,
    printer_id: 2,
    printer_name: printers[1].name,
    target_model: null,
    target_location: null,
    status: 'printing',
    position: 1,
    scheduled_time: null,
    started_at: '2026-07-01T13:25:00Z',
    dispatched_at: '2026-07-01T13:24:00Z',
    completed_at: null,
    print_time_seconds: 10_800,
    filament_used_grams: 164,
    created_by_username: 'Priya',
    waiting_reason: null,
    manual_start: false,
    batch_id: null,
    batch_name: null,
  },
  {
    id: 3,
    archive_id: 103,
    archive_name: 'Workshop Tool Organiser',
    archive_thumbnail: null,
    library_file_id: null,
    printer_id: 1,
    printer_name: printers[0].name,
    target_model: null,
    target_location: null,
    status: 'pending',
    position: 2,
    scheduled_time: '2026-07-01T15:00:00Z',
    started_at: null,
    dispatched_at: null,
    completed_at: null,
    print_time_seconds: 5_400,
    filament_used_grams: 82,
    created_by_username: 'Morgan',
    waiting_reason: null,
    manual_start: false,
    batch_id: null,
    batch_name: null,
  },
  {
    id: 4,
    archive_id: 104,
    archive_name: 'Production Alignment Jig',
    archive_thumbnail: null,
    library_file_id: null,
    printer_id: 3,
    printer_name: printers[2].name,
    target_model: null,
    target_location: null,
    status: 'pending',
    position: 3,
    scheduled_time: '2026-07-01T17:30:00Z',
    started_at: null,
    dispatched_at: null,
    completed_at: null,
    print_time_seconds: 7_200,
    filament_used_grams: 126,
    created_by_username: 'Alex',
    waiting_reason: null,
    manual_start: false,
    batch_id: 7,
    batch_name: 'Production Setup',
  },
  {
    id: 5,
    archive_id: 105,
    archive_name: 'Calibration Kit',
    archive_thumbnail: null,
    library_file_id: null,
    printer_id: 3,
    printer_name: printers[2].name,
    target_model: null,
    target_location: null,
    status: 'pending',
    position: 4,
    scheduled_time: null,
    started_at: null,
    dispatched_at: null,
    completed_at: null,
    print_time_seconds: 3_600,
    filament_used_grams: 48,
    created_by_username: 'Alex',
    waiting_reason: null,
    manual_start: false,
    batch_id: 7,
    batch_name: 'Production Setup',
  },
  {
    id: 6,
    archive_id: 106,
    archive_name: 'Replacement Fan Shroud',
    archive_thumbnail: null,
    library_file_id: null,
    printer_id: 2,
    printer_name: printers[1].name,
    target_model: null,
    target_location: null,
    status: 'pending',
    position: 5,
    scheduled_time: null,
    started_at: null,
    dispatched_at: null,
    completed_at: null,
    print_time_seconds: 2_700,
    filament_used_grams: 36,
    created_by_username: 'Priya',
    waiting_reason: 'Waiting for matching PETG',
    manual_start: false,
    batch_id: null,
    batch_name: null,
  },
];

const printLog = {
  total: 5,
  items: [
    {
      id: 1,
      archive_id: 1,
      print_name: 'Tool Organiser',
      printer_name: printers[0].name,
      printer_id: 1,
      status: 'completed',
      started_at: '2026-06-29T09:00:00Z',
      completed_at: '2026-06-29T11:00:00Z',
      duration_seconds: 7200,
      filament_type: 'PLA',
      filament_color: '#00AE42',
      filament_used_grams: 86,
      cost: 1.72,
      energy_kwh: 0.42,
      energy_cost: 0.11,
      failure_reason: null,
      thumbnail_path: null,
      created_by_id: null,
      created_by_username: 'Morgan',
      created_at: '2026-06-29T09:00:00Z',
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      id: index + 2,
      archive_id: index + 2,
      print_name: `Workshop Part ${index + 1}`,
      printer_name: printers[0].name,
      printer_id: 1,
      status: index === 3 ? 'failed' : 'completed',
      started_at: `2026-06-${25 + index}T09:00:00Z`,
      completed_at: `2026-06-${25 + index}T10:30:00Z`,
      duration_seconds: 5400,
      filament_type: 'PLA',
      filament_color: '#F5F1E8',
      filament_used_grams: 54,
      cost: 1.08,
      energy_kwh: 0.31,
      energy_cost: 0.08,
      failure_reason: index === 3 ? 'User stopped' : null,
      thumbnail_path: null,
      created_by_id: null,
      created_by_username: 'Morgan',
      created_at: `2026-06-${25 + index}T09:00:00Z`,
    })),
  ],
};

const appSettings = {
  currency: 'GBP',
  time_format: '24h',
  date_format: 'eu',
  check_updates: false,
  check_printer_firmware: false,
  dark_style: 'vibrant',
  dark_background: 'cool',
  dark_accent: 'green',
  light_style: 'classic',
  light_background: 'neutral',
  light_accent: 'green',
  spoolman_enabled: false,
  user_notifications_enabled: false,
};

async function mockApi(page: Page) {
  const unhandledRequests = new Set<string>();
  const fixtureState = {
    showHealthIssue: false,
    showKioskPlateClear: false,
  };

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const statusMatch = pathname.match(/^\/api\/v1\/printers\/(\d+)\/status$/);

    if (pathname.match(/^\/api\/v1\/printers\/\d+\/camera\/stream$/)) {
      await route.fulfill({ path: CAMERA_PLACEHOLDER, contentType: 'image/png' });
      return;
    }

    if (statusMatch) {
      const printerId = Number(statusMatch[1]) as keyof typeof printerStatuses;
      let status = printerStatuses[printerId];
      if (fixtureState.showHealthIssue && printerId === 1) {
        status = {
          ...status,
          wifi_signal: -72,
          door_open: true,
        };
      }
      if (fixtureState.showKioskPlateClear && printerId === 3) {
        status = {
          ...status,
          state: 'FINISH',
          current_print: 'Calibration_Fixture.3mf',
          subtask_name: 'Calibration Fixture',
          gcode_file: 'Calibration_Fixture.gcode.3mf',
          progress: 100,
          awaiting_plate_clear: true,
        };
      }
      await route.fulfill({ json: status });
      return;
    }

    if (pathname === '/api/v1/auth/status') {
      await route.fulfill({ json: { auth_enabled: false, requires_setup: false } });
    } else if (pathname === '/api/v1/auth/ws-token') {
      await route.fulfill({ json: { token: 'readme-websocket-token' } });
    } else if (pathname === '/api/v1/system/appliance') {
      await route.fulfill({ json: { locale: 'en' } });
    } else if (pathname === '/api/v1/settings/') {
      await route.fulfill({ json: appSettings });
    } else if (pathname === '/api/v1/settings/ui-preferences') {
      await route.fulfill({
        json: {
          require_plate_clear: true,
          check_printer_firmware: false,
          camera_view_mode: 'window',
          time_format: '24h',
          date_format: 'eu',
          ams_humidity_good: 40,
          ams_humidity_fair: 60,
          ams_temp_good: 28,
          ams_temp_fair: 35,
        },
      });
    } else if (pathname === '/api/v1/settings/default-sidebar-order') {
      await route.fulfill({ json: { default_sidebar_order: '' } });
    } else if (pathname === '/api/v1/updates/version') {
      await route.fulfill({ json: { version: '1.0.0', repo: 'EdwardChamberlain/grove-control' } });
    } else if (pathname === '/api/v1/updates/check') {
      await route.fulfill({
        json: {
          update_available: false,
          current_version: '1.0.0',
          latest_version: '1.0.0',
        },
      });
    } else if (pathname === '/api/v1/external-links/') {
      await route.fulfill({ json: [] });
    } else if (pathname === '/api/v1/smart-plugs/') {
      await route.fulfill({ json: [] });
    } else if (pathname.match(/^\/api\/v1\/smart-plugs\/by-printer\/\d+\/scripts$/)) {
      await route.fulfill({ json: [] });
    } else if (pathname.match(/^\/api\/v1\/smart-plugs\/by-printer\/\d+$/)) {
      await route.fulfill({ json: null });
    } else if (pathname === '/api/v1/support/debug-logging') {
      await route.fulfill({
        json: { enabled: false, enabled_at: null, duration_seconds: null },
      });
    } else if (pathname === '/api/v1/printers/developer-mode-warnings') {
      await route.fulfill({ json: [] });
    } else if (pathname === '/api/v1/pending-uploads/count') {
      await route.fulfill({ json: { count: 0 } });
    } else if (pathname === '/api/v1/pending-uploads/') {
      await route.fulfill({ json: [] });
    } else if (pathname === '/api/v1/printers/') {
      await route.fulfill({ json: printers });
    } else if (pathname === '/api/v1/printers/available-filaments') {
      await route.fulfill({ json: [] });
    } else if (pathname === '/api/v1/printers/camera/stream-token') {
      await route.fulfill({ json: { token: 'readme-screenshot-token' } });
    } else if (pathname.match(/^\/api\/v1\/firmware\/updates\/\d+$/)) {
      const printerId = Number(pathname.split('/').at(-1));
      const printer = printers.find((item) => item.id === printerId);
      await route.fulfill({
        json: {
          printer_id: printerId,
          printer_name: printer?.name ?? `Printer ${printerId}`,
          model: printer?.model ?? null,
          current_version: '01.09.00.00',
          latest_version: '01.09.00.00',
          update_available: false,
          download_url: null,
          release_notes: null,
          available_versions: [],
        },
      });
    } else if (pathname.match(/^\/api\/v1\/printers\/\d+\/camera\/stop$/)) {
      await route.fulfill({ json: { success: true } });
    } else if (pathname.match(/^\/api\/v1\/printers\/\d+\/current-print-user$/)) {
      const printerId = Number(pathname.split('/').at(-2));
      const usernames: Record<number, string> = { 1: 'Morgan', 2: 'Priya', 3: 'Alex' };
      await route.fulfill({ json: { username: usernames[printerId] ?? 'Morgan' } });
    } else if (pathname.match(/^\/api\/v1\/printers\/\d+\/ams-labels$/)) {
      await route.fulfill({ json: { 0: 'Materials' } });
    } else if (pathname.match(/^\/api\/v1\/printers\/\d+\/slot-presets$/)) {
      await route.fulfill({ json: {} });
    } else if (pathname === '/api/v1/queue/') {
      const printerId = url.searchParams.get('printer_id');
      const queueStatus = url.searchParams.get('status');
      const filteredQueue = queueItems.filter((item) => (
        (!fixtureState.showKioskPlateClear || item.id !== 2)
        && (!printerId || item.printer_id === Number(printerId))
        && (!queueStatus || item.status === queueStatus)
      ));
      await route.fulfill({ json: filteredQueue });
    } else if (pathname === '/api/v1/print-log/') {
      await route.fulfill({ json: printLog });
    } else if (pathname === '/api/v1/maintenance/overview') {
      await route.fulfill({
        json: fixtureState.showHealthIssue
          ? [{
              printer_id: 1,
              printer_name: printers[0].name,
              due_count: 0,
              warning_count: 1,
              total_print_hours: 482.6,
            }]
          : [],
      });
    } else if (pathname === '/api/v1/spoolman/status') {
      await route.fulfill({ json: { enabled: false, connected: false, url: null } });
    } else if (pathname === '/api/v1/inventory/assignments') {
      await route.fulfill({ json: [] });
    } else if (pathname === '/api/v1/inventory/colors/map') {
      await route.fulfill({ json: { colors: {} } });
    } else if (pathname === '/api/v1/archives/no-3mf-warning') {
      await route.fulfill({ json: { has_fallback: false } });
    } else if (pathname === '/api/v1/archives/') {
      await route.fulfill({ json: [archive] });
    } else if (pathname === `/api/v1/archives/${archive.id}`) {
      await route.fulfill({ json: archive });
    } else if (pathname === `/api/v1/archives/${archive.id}/plates`) {
      await route.fulfill({ json: { is_multi_plate: false, plates: [] } });
    } else if (pathname === `/api/v1/archives/${archive.id}/filament-requirements`) {
      await route.fulfill({
        json: {
          archive_id: archive.id,
          filename: archive.filename,
          plate_id: null,
          filaments: [],
        },
      });
    } else if (pathname === `/api/v1/library/folders/by-archive/${archive.id}`) {
      await route.fulfill({ json: [] });
    } else if (pathname === '/api/v1/projects/') {
      await route.fulfill({ json: [] });
    } else {
      unhandledRequests.add(`${request.method()} ${pathname}${url.search}`);
      await route.fulfill({
        status: 501,
        json: { detail: `Unhandled screenshot fixture request: ${pathname}` },
      });
    }
  });

  return { fixtureState, unhandledRequests };
}

async function prepareScreenshot(page: Page) {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

test('regenerates the README product screenshots', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-07-01T14:00:00Z'));
  await stubWebSocket(page);
  await page.addInitScript(() => {
    if (localStorage.getItem('readme-screenshot-initialized') === 'true') return;
    localStorage.clear();
    localStorage.setItem('theme-mode', 'dark');
    localStorage.setItem('dark-style', 'vibrant');
    localStorage.setItem('dark-background', 'cool');
    localStorage.setItem('dark-accent', 'green');
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('sidebarExpanded', 'true');
    localStorage.setItem(
      'sidebarHiddenSystemItems',
      JSON.stringify(['inventory', 'archives', 'projects', 'files', 'makerworld', 'profiles']),
    );
    localStorage.setItem('printerViewMode', 'single');
    localStorage.setItem('singlePrinterViewId', '1');
    localStorage.setItem('readme-screenshot-initialized', 'true');
  });
  const { fixtureState, unhandledRequests } = await mockApi(page);

  await page.goto('/');
  await expect(page.getByTestId('cockpit-layout')).toBeVisible();
  await expect(page.getByText('Modular Planter', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Morgan', { exact: true })).toBeVisible();
  const camera = page.locator('img[src*="/camera/stream"]').first();
  await expect(camera).toBeVisible();
  await expect.poll(() => camera.evaluate(
    (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
  )).toBe(true);
  await prepareScreenshot(page);
  await page.screenshot({
    path: COCKPIT_SCREENSHOT,
    animations: 'disabled',
  });

  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByTestId('cockpit-layout')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Workshop X1C', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prototype P1S', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Production A1', exact: true })).toBeVisible();
  await prepareScreenshot(page);
  await page.screenshot({
    path: LIST_SCREENSHOT,
    animations: 'disabled',
  });

  fixtureState.showHealthIssue = true;
  await page.evaluate(() => localStorage.setItem('printerViewMode', 'detail'));
  await page.reload();
  const healthCard = page.locator('#printer-card-1');
  await expect(healthCard).toBeVisible();
  await expect(page.getByText('1 printing', { exact: true })).toBeVisible();
  await expect(page.getByText('1 paused', { exact: true })).toBeVisible();
  await expect(page.getByText('1 available', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '4 Print Queue' })).toBeVisible();
  const healthIndicator = healthCard.getByRole('button', {
    name: 'Machine health: Requires attention',
  });
  await expect(healthIndicator).toBeVisible();
  await prepareScreenshot(page);
  await healthIndicator.click();
  await expect(page.getByText('Status details', { exact: true })).toBeVisible();
  await expect(page.getByTestId('printer-health-network')).toContainText('-72dBm');
  await expect(page.getByTestId('printer-health-maintenance')).toContainText('1 warning');
  await expect(page.getByTestId('printer-health-door')).toContainText('Open');
  await prepareScreenshot(page);
  await page.screenshot({
    path: HEALTH_SCREENSHOT,
    animations: 'disabled',
  });

  await page.evaluate(() => {
    localStorage.setItem(
      'sidebarHiddenSystemItems',
      JSON.stringify(['inventory', 'projects', 'files', 'makerworld', 'profiles']),
    );
  });
  await page.goto('/archives');
  await expect(page.getByRole('heading', { name: 'Archives', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Print', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Print', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Any X1C', exact: true }).click();
  await page.getByRole('button', { name: 'Queue options', exact: true }).click();
  await page.locator('label', { hasText: 'Wait for drying to complete' }).click();
  await page.locator('label', { hasText: 'Postpone print' }).click();
  await expect(page.getByRole('checkbox', { name: 'Wait for drying to complete' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Postpone print' })).toBeChecked();
  await expect(page.getByLabel('Do not start before')).toBeVisible();
  await prepareScreenshot(page);
  await page.screenshot({
    path: PRINT_MODAL_SCREENSHOT,
    animations: 'disabled',
  });

  fixtureState.showKioskPlateClear = true;
  await page.goto('/kiosk');
  await expect(page.getByTestId('kiosk-page')).toBeVisible();
  await expect(page.getByTestId('kiosk-printer-1')).toContainText('Modular Planter');
  await expect(page.getByTestId('kiosk-printer-3')).toContainText('Plate clear required');
  await expect(page.getByText('Production Alignment Jig', { exact: true })).toBeVisible();
  await expect(page.getByTestId('kiosk-queue-status-3')).toContainText('Scheduled');
  await prepareScreenshot(page);
  await page.screenshot({
    path: KIOSK_SCREENSHOT,
    animations: 'disabled',
  });

  expect(
    [...unhandledRequests],
    'All API calls used by the README demo must have deterministic fixtures',
  ).toEqual([]);
});
