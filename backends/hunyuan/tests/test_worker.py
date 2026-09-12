import worker_tests_base as base_worker_tests


class WorkerProtocolTests(base_worker_tests.WorkerProtocolTests):
    """Legacy worker regression suite with protocol-v2 expectation."""

    def test_serve_ping_returns_same_job_id(self) -> None:
        module = self.load_worker_module()
        replies: list[dict[str, object]] = []
        keep_running = module.dispatch_serve_command(
            {"command": "ping", "job_id": "job-1"},
            cache=module.PipelineCache(),
            emit_fn=replies.append,
        )
        self.assertTrue(keep_running)
        self.assertEqual(replies[-1]["job_id"], "job-1")
        self.assertEqual(replies[-1]["event"], "pong")
        self.assertEqual(replies[-1]["protocol_version"], 2)
