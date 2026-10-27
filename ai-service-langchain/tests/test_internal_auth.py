import unittest
from unittest import mock

from security import verify_internal_token


class InternalServiceAuthenticationTests(unittest.TestCase):
    def test_health_is_the_only_unauthenticated_path(self):
        self.assertTrue(verify_internal_token('/api/health', None, 'secret'))

    def test_non_health_path_requires_the_configured_token(self):
        self.assertFalse(verify_internal_token('/api/chat', None, 'secret'))
        self.assertFalse(verify_internal_token('/api/chat', 'wrong', 'secret'))
        self.assertTrue(verify_internal_token('/api/chat', 'secret', 'secret'))

    def test_missing_configuration_fails_closed(self):
        self.assertFalse(verify_internal_token('/api/chat', '', ''))

    def test_application_middleware_enforces_the_token(self):
        from fastapi.testclient import TestClient
        from main import app

        with mock.patch.dict('os.environ', {'AI_SERVICE_TOKEN': 'test-token'}, clear=False):
            with TestClient(app) as client:
                self.assertEqual(client.get('/api/health').status_code, 200)
                self.assertEqual(client.get('/api/config/status').status_code, 401)
                self.assertEqual(
                    client.get('/api/config/status', headers={'X-Internal-Service-Token': 'test-token'}).status_code,
                    200,
                )


if __name__ == '__main__':
    unittest.main()
