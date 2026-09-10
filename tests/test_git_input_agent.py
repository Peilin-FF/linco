"""Git object transfers use exact UTF-8 bytes; all repositories here are disposable."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('linco_git_input_test', Path(__file__).parents[1] / 'src-tauri/src/agent/linco_agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class GitInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='linco-git-input-')
        self.repo = self.temp.name
        subprocess.run(['git', 'init', self.repo], check=True, capture_output=True)

    def tearDown(self):
        self.temp.cleanup()

    def transfer(self, args, content):
        result = agent.op_git_input({'repo': self.repo, 'args': args, 'input': content})
        self.assertEqual(result['code'], 0, result['stderr'])
        return result['stdout'].strip()

    def test_exact_unicode_crlf_empty_and_nul_tree_entries(self):
        for content in ['', 'α 研究 🧪\r\n', 'no final newline']:
            blob = self.transfer(['hash-object', '-w', '--stdin'], content)
            result = subprocess.run(['git', '-C', self.repo, 'cat-file', 'blob', blob], check=True, capture_output=True)
            self.assertEqual(result.stdout, content.encode('utf-8'))
        tree = self.transfer(['mktree', '-z'], '100644 blob ' + blob + '\t研究.tex\0')
        result = subprocess.run(['git', '-C', self.repo, 'ls-tree', '-z', tree], check=True, capture_output=True)
        self.assertIn('研究.tex\0'.encode('utf-8'), result.stdout)
        self.assertEqual(agent.OPS['git_input'], agent.op_git_input)

    def test_rejects_mutating_worktree_commands_and_invalid_inputs(self):
        for args, content in [(['reset', '--hard'], ''), (['hash-object', '-w', '--stdin'], None), (['mktree', '-z'], 'x' * 2_000_001)]:
            with self.assertRaises(ValueError):
                self.transfer(args, content)


if __name__ == '__main__':
    unittest.main()
