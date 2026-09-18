# SpoolBuddy integration boundary

Grove Control no longer bundles or manages the SpoolBuddy hardware daemon,
touchscreen kiosk, installer, SSH update flow, or device-management API.
Hardware support now belongs in the [standalone upstream SpoolBuddy project](https://github.com/macpit/spoolbuddy).

Existing inventory clients remain supported through the ordinary Grove Control
surfaces:

- /api/v1/inventory/spools for spool CRUD and
  PATCH /api/v1/inventory/spools/{id}/link-tag
- PATCH /api/v1/inventory/spools/{id}/weight for local gross-weight
  synchronization
- /api/v1/inventory/assignments for AMS slot assignment
- /api/v1/spoolman/inventory/spools and
  /api/v1/spoolman/inventory/slot-assignments when Spoolman mode is enabled

Clients should authenticate with an API key that has read-status and inventory-management
permissions enabled. These scopes can be created and managed from Grove Control's API-key
settings; the former bundled `kiosk-bootstrap` command is removed with the hardware suite.

The Grove-hosted /api/v1/spoolbuddy/* device, NFC, scale, calibration,
diagnostics, display, system-command, and update endpoints, together with the
/spoolbuddy/* UI, are removed. Upstream SpoolBuddy should use the supported
inventory and Spoolman surfaces above when it needs to exchange spool metadata.

The removal does not reset data. Existing inventory, RFID/tag metadata, AMS
assignments, and print history remain in place. The legacy spoolbuddy_devices
table is left untouched for safe upgrades, but Grove Control no longer reads or
writes it.
