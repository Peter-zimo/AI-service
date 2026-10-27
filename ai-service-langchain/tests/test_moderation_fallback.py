import unittest

from ai.sensitive import local_sensitive_fallback


class ModerationFallbackTests(unittest.TestCase):
    def test_local_fallback_blocks_known_high_risk_terms(self):
        result = local_sensitive_fallback('这里有毒品交易信息')
        self.assertTrue(result['has_sensitive'])
        self.assertEqual(result['risk_level'], 'high')

    def test_local_fallback_allows_normal_bike_service_text(self):
        result = local_sensitive_fallback('我要申请骑行退款')
        self.assertFalse(result['has_sensitive'])


if __name__ == '__main__':
    unittest.main()
