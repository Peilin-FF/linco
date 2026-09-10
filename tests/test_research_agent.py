"""Run on Linux/WSL: selected evidence must never escape its project root."""
import base64
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('linco_agent_test', Path(__file__).parents[1] / 'src-tauri/src/agent/linco_agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

class ResearchSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='linco-evidence-test-')
        self.root = Path(self.temp.name)
        (self.root / 'results.csv').write_text('method,score\nbaseline,1\nours,2\n')

    def tearDown(self):
        self.temp.cleanup()

    def capture(self, paths):
        return agent.op_research_snapshot({'repo': str(self.root), 'paths': paths})

    def test_exact_bytes_and_no_extra_files(self):
        (self.root / 'private.txt').write_text('not selected')
        result = self.capture(['results.csv'])
        self.assertEqual(len(result['files']), 1)
        self.assertEqual(base64.b64decode(result['files'][0]['data']), (self.root / 'results.csv').read_bytes())

    def test_traversal_hidden_and_symlinks_rejected(self):
        (self.root / 'link.csv').symlink_to(self.root / 'results.csv')
        (self.root / 'dirlink').symlink_to(self.root, target_is_directory=True)
        for path in ['../results.csv', '/etc/passwd', '.env', 'link.csv', 'dirlink/results.csv']:
            with self.subTest(path=path), self.assertRaises(Exception):
                self.capture([path])

    def test_size_binary_and_fifo_rejected(self):
        (self.root / 'big.txt').write_bytes(b'x' * (1024 * 1024 + 1))
        (self.root / 'binary.txt').write_bytes(b'a\x00b')
        os.mkfifo(self.root / 'pipe.txt')
        for path in ['big.txt', 'binary.txt', 'pipe.txt']:
            with self.subTest(path=path), self.assertRaises(Exception):
                self.capture([path])

    def test_missing_file_and_count_limit(self):
        for paths in [[], ['missing.txt'], ['results.csv'] * 17]:
            with self.assertRaises(Exception):
                self.capture(paths)

    def test_latex_snapshot_excludes_code_and_credentials(self):
        (self.root / 'main.tex').write_text('test')
        (self.root / 'train.py').write_text('not needed for compilation')
        (self.root / '.env').write_text('not for transfer')
        names = [f['path'] for f in agent.op_latex_snapshot({'repo': str(self.root)})['files']]
        self.assertIn('main.tex', names)
        self.assertNotIn('train.py', names)
        self.assertNotIn('.env', names)

    def test_latex_does_not_follow_directory_symlinks_or_block_on_fifo(self):
        (self.root / 'link').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(Exception):
            agent.op_latex_snapshot({'repo': str(self.root)})
        (self.root / 'link').unlink()
        os.mkfifo(self.root / 'pipe.tex')
        with self.assertRaises(Exception):
            agent.op_latex_snapshot({'repo': str(self.root)})

    def test_rejects_files_changed_after_their_initial_capture(self):
        original = agent._snapshot_unchanged
        def change_then_check(root_fd, observed):
            (self.root / 'results.csv').write_text('method,score\nchanged,900\n')
            return original(root_fd, observed)
        with mock.patch.object(agent, '_snapshot_unchanged', side_effect=change_then_check):
            with self.assertRaisesRegex(ValueError, 'changed'):
                self.capture(['results.csv'])

if __name__ == '__main__':
    unittest.main()
