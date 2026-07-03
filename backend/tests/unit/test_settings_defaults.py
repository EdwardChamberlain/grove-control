from backend.app.schemas.settings import AppSettings


def test_new_installs_require_plate_clear_confirmation_by_default():
    assert AppSettings().require_plate_clear is True
