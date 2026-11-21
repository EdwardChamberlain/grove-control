"""Helpers for tests that build a schema straight from ``Base.metadata``."""

import importlib
import pkgutil


def register_all_models() -> None:
    """Import every module in ``backend.app.models`` so ``create_all`` sees every table.

    ``backend/app/models/__init__.py`` does not import every model, so
    ``import backend.app.models`` alone only registers whatever the rest of the test
    process happened to import first. A test that runs ``run_migrations`` against a
    ``create_all`` schema then passes or fails depending on test order (migrations
    ALTER tables such as ``virtual_printers`` that must exist).
    """
    import backend.app.models as models_package

    for module in pkgutil.iter_modules(models_package.__path__):
        importlib.import_module(f"{models_package.__name__}.{module.name}")
