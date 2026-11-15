"""Unit tests for 2FA helper functions in mfa.py."""

import base64
import string
from datetime import datetime, timezone

import pyotp
import pytest
from passlib.context import CryptContext

from backend.app.api.routes.mfa import _generate_backup_codes, _generate_totp_qr_b64, _totp_counter_for_code


class TestBackupCodeGeneration:
    """Tests for backup code helpers."""

    def test_generates_ten_codes(self):
        plain, hashed = _generate_backup_codes()
        assert len(plain) == 10
        assert len(hashed) == 10

    def test_codes_are_eight_chars(self):
        plain, _ = _generate_backup_codes()
        for code in plain:
            assert len(code) == 8

    def test_codes_are_alphanumeric(self):
        allowed = set(string.ascii_uppercase + string.digits)
        plain, _ = _generate_backup_codes()
        for code in plain:
            assert all(c in allowed for c in code)

    def test_hashes_verify_against_plain(self):
        ctx = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")
        plain, hashed = _generate_backup_codes()
        for p, h in zip(plain, hashed, strict=True):
            assert ctx.verify(p, h)

    def test_codes_are_unique(self):
        plain, _ = _generate_backup_codes()
        assert len(set(plain)) == 10


class TestTOTPQRCode:
    """Tests for QR code generation helper."""

    def test_generates_base64_png(self):
        uri = "otpauth://totp/Grove Control:testuser?secret=BASE32SECRET&issuer=Grove Control"
        result = _generate_totp_qr_b64(uri)
        decoded = base64.b64decode(result)
        assert decoded[:4] == b"\x89PNG"


class TestTOTPReplayCounter:
    """Tests for mapping a verified code to its actual time-step counter."""

    def test_previous_window_code_uses_previous_counter(self):
        now = datetime(2026, 1, 1, 12, 0, 15, tzinfo=timezone.utc)
        # pyotp 2.12 rejects secrets under 112 bits, so use a 160-bit one.
        totp = pyotp.TOTP("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")

        current_counter = totp.timecode(now)
        previous_code = totp.at(now, counter_offset=-1)

        assert _totp_counter_for_code(totp, previous_code, now) == current_counter - 1
