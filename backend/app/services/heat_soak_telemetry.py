"""Keep firmware heater reports separate from optimistic UI temperature targets."""

import math
import time


def record_heat_soak_reports(state, data: dict) -> None:
    def mapping(value):
        return value if isinstance(value, dict) else {}

    def number(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

    def record(key, value, maximum):
        if number(value) and 0 <= value <= maximum:
            state.heat_soak_reports[key] = (float(value), time.time())

    device = mapping(data.get("device"))
    bed = mapping(mapping(device.get("bed")).get("info"))
    chamber = mapping(mapping(device.get("ctc")).get("info"))
    airduct = mapping(device.get("airduct"))
    if "bed_target_temper" in data:
        record("bed_target", data["bed_target_temper"], 120)
    elif number(bed.get("temp")):
        record("bed_target", int(bed["temp"]) // 65536 if bed["temp"] > 500 else 0, 120)
    if "target" in chamber:
        record("chamber_target", chamber["target"], 60)
    elif "mc_target_cham" in data:
        record("chamber_target", data["mc_target_cham"], 60)
    else:
        value = chamber.get("temp", data.get("chamber_temper", mapping(data.get("info")).get("temp")))
        if number(value):
            record("chamber_target", int(value) // 65536 if value > 500 else 0, 60)
    if "modeCur" in airduct:
        record("airduct", airduct["modeCur"], 1)
