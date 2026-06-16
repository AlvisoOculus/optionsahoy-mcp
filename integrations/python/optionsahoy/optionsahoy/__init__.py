"""OptionsAhoy: a thin, dependency-light client for the keyless public REST API."""

from optionsahoy.client import (
    DEFAULT_BASE_URL,
    OptionsAhoyClient,
    OptionsAhoyError,
)

__all__ = ["OptionsAhoyClient", "OptionsAhoyError", "DEFAULT_BASE_URL"]
__version__ = "0.1.6"
