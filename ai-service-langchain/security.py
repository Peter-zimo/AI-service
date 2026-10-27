"""Internal-service authentication helpers."""

import hmac


def verify_internal_token(path: str, received_token: str | None, configured_token: str) -> bool:
    """Allow health checks, require a configured token for every other API path."""
    if path == "/api/health":
        return True
    if not configured_token or not received_token:
        return False
    return hmac.compare_digest(received_token, configured_token)
