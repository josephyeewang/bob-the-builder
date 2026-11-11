"""Exercise the installed gh against loopback only, with isolated fake auth.

Unlike the publisher's fake API tests, these run the actual binary upload CLI
construction. No GitHub request, real auth store, or candidate code is used.
"""
import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from skill_publish import ApiError, Gh


@unittest.skipUnless(shutil.which('gh'), 'Real transport checks need the GitHub CLI')
class GhTransportTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.forced_status = None
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        # Preserve HOME unchanged. Config and token overrides prevent consulting
        # actual auth stores; neither headers nor environment values are logged.
        self.environment = dict(os.environ, GH_CONFIG_DIR=self.temp.name,
                                GH_TOKEN='fake-local-test', GITHUB_TOKEN='fake-local-test',
                                GH_ENTERPRISE_TOKEN='fake-local-test',
                                GITHUB_ENTERPRISE_TOKEN='fake-local-test', GH_PROMPT_DISABLED='1')
        for key in ('GH_DEBUG', 'GH_HOST', 'GH_PAGER', 'PAGER'):
            self.environment.pop(key, None)
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                size = self.headers.get('Content-Length')
                transfer = self.headers.get('Transfer-Encoding')
                if size is not None:
                    body = self.rfile.read(int(size))
                elif transfer == 'chunked':
                    chunks = []
                    while True:
                        count = int(self.rfile.readline().split(b';', 1)[0], 16)
                        if not count:
                            self.rfile.readline()
                            break
                        chunks.append(self.rfile.read(count))
                        self.rfile.read(2)
                    body = b''.join(chunks)
                else:
                    body = b''
                owner.requests.append({'length': size, 'transfer': transfer,
                                       'type': self.headers.get('Content-Type'), 'body': body})
                status = owner.forced_status or (201 if size is not None else 411)
                result = {'id': 7, 'name': 'sample.zip'} if status == 201 else {
                    'message': 'fixture-private-message-do-not-echo'}
                data = json.dumps(result).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.original_run = subprocess.run

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def local_cli(self, command, **kwargs):
        command = list(command)
        self.assertEqual(command[:2], ['gh', 'api'])
        url = command[4]
        # Fail closed if production starts calling any unrecognized endpoint.
        self.assertTrue(url.startswith(('https://uploads.github.com/repos/example/skills/',
                                        'https://api.github.com/repos/example/skills/')))
        command[0] = shutil.which('gh')
        command[4] = f'http://127.0.0.1:{self.server.server_port}/' + url.split('/', 3)[3]
        return self.original_run(command, **dict(kwargs, env=self.environment, timeout=10))

    def test_upload_real_cli_sends_sized_exact_binary(self):
        data = b'PK\x03\x04\x00\xffbinary\x00\x80\n' * 100
        with patch('skill_publish.subprocess.run', side_effect=self.local_cli):
            result = Gh().upload('example/skills', 7, 'sample.zip', data)
        self.assertEqual(result['id'], 7)
        self.assertEqual(len(self.requests), 1)
        request = self.requests[0]
        self.assertEqual(request['length'], str(len(data)))
        self.assertIsNone(request['transfer'])
        self.assertEqual(request['type'], 'application/octet-stream')
        self.assertEqual(request['body'], data)

    def test_upload_real_cli_retains_http_status_without_echoing_response(self):
        self.forced_status = 411
        with patch('skill_publish.subprocess.run', side_effect=self.local_cli):
            with self.assertRaises(ApiError) as caught:
                Gh().upload('example/skills', 7, 'sample.zip', b'abc')
        self.assertEqual(caught.exception.status, 411)
        self.assertIn('HTTP 411', str(caught.exception))
        self.assertNotIn('fixture-private-message', str(caught.exception))

    def test_json_api_real_cli_retains_http_status_without_echoing_response(self):
        self.forced_status = 403
        with patch('skill_publish.subprocess.run', side_effect=self.local_cli):
            with self.assertRaises(ApiError) as caught:
                Gh().api('POST', 'https://api.github.com/repos/example/skills/ref', {'key': 'value'})
        self.assertEqual(caught.exception.status, 403)
        self.assertNotIn('fixture-private-message', str(caught.exception))


class GhDiagnosticTests(unittest.TestCase):
    def test_transport_failure_is_distinct_from_an_http_status(self):
        result = subprocess.CompletedProcess([], 1, b'', b'network failed: fixture-private-message')
        for action in (lambda: Gh().upload('example/skills', 7, 'sample.zip', b'abc'),
                       lambda: Gh().api('POST', 'repos/example/skills/ref', {'key': 'value'})):
            with self.subTest(action=action), patch('skill_publish.subprocess.run', return_value=result):
                with self.assertRaises(ApiError) as caught:
                    action()
                self.assertIsNone(caught.exception.status)
                self.assertIn('CLI exit 1', str(caught.exception))
                self.assertIn('no HTTP status', str(caught.exception))
                self.assertNotIn('HTTP 0', str(caught.exception))
                self.assertNotIn('fixture-private-message', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
