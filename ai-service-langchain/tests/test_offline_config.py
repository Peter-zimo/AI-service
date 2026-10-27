import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import knowledge.embedding as embedding
import knowledge.retriever as retriever


class OfflineConfigurationTests(unittest.TestCase):
    def test_explicit_node_sqlite_path_is_used(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "service.db"
            database.touch()
            with mock.patch.dict(os.environ, {"NODE_SQLITE_PATH": str(database)}, clear=False):
                self.assertEqual(retriever.resolve_node_sqlite_path(), database)

    def test_missing_local_bge_model_does_not_attempt_download(self):
        with mock.patch.object(embedding, "_BGE_MODEL_NAME", "not-a-local-directory"), \
             mock.patch.dict(os.environ, {}, clear=False):
            self.assertFalse(embedding._load_bge())

    def test_postgres_mode_uses_node_as_the_knowledge_authority(self):
        with mock.patch.dict(os.environ, {"DB_TYPE": "postgres", "AI_SERVICE_TOKEN": "test-token"}, clear=False), \
             mock.patch.object(retriever, "fetch_node_knowledge", return_value=[
                 {"id": "k1", "question": "问题", "answer": "答案", "keywords": ["词"]}
             ]) as fetch:
            items = retriever.load_authoritative_knowledge()
        fetch.assert_called_once()
        self.assertEqual(items[0].question, "问题")


if __name__ == "__main__":
    unittest.main()
