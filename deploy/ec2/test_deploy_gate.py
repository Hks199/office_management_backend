"""Execute the workflow's promotion gate with synthetic GitHub API responses."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/deploy.yaml"
SHA = "a" * 40
OTHER_SHA = "b" * 40
REPOSITORY = "example/office-backend"


def gate_script():
    """Extract the actual Bash block, without adding a YAML dependency to CI."""
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    marker = "      - name: Select current main commit with successful CI"
    start = lines.index(marker)
    run_start = lines.index("        run: |", start) + 1
    script = []
    for line in lines[run_start:]:
        if not line.strip():
            script.append("")
        elif line.startswith("          "):
            script.append(line[10:])
        else:
            if not line.startswith(("      - ", "  ")):
                raise AssertionError("Unexpected indentation in the workflow gate")
            break
    if not script:
        raise AssertionError("The workflow promotion gate is empty")
    return "\n".join(script) + "\n"


def ci_run(**changes):
    run = {
        "run_number": 1,
        "status": "completed",
        "conclusion": "success",
        "head_sha": SHA,
        "head_repository": {"full_name": REPOSITORY},
        "event": "push",
        "head_branch": "main",
    }
    run.update(changes)
    return run


FAKE_GH = r'''
import json
import os
from pathlib import Path
import sys

arguments = sys.argv[1:]
with open(os.environ["FAKE_GH_LOG"], "a", encoding="utf-8") as stream:
    stream.write(json.dumps(arguments) + "\n")
fixture = json.loads(Path(os.environ["FAKE_GH_FIXTURE"]).read_text(encoding="utf-8"))
if not arguments or arguments[0] != "api" or "--jq" not in arguments:
    raise SystemExit("Only the gate's GitHub API calls are supported")
query = arguments[arguments.index("--jq") + 1]
if any(argument.endswith("/git/ref/heads/main") for argument in arguments):
    if fixture.get("main_error"):
        raise SystemExit("Synthetic main lookup failure")
    if query != ".object.sha":
        raise SystemExit("Unexpected main lookup projection")
    print(fixture["main_sha"])
elif any(argument.endswith("/actions/workflows/ci.yml/runs") for argument in arguments):
    if fixture.get("ci_error"):
        raise SystemExit("Synthetic CI lookup failure")
    # Model the six-column response requested from gh's jq projection. The tests
    # separately assert that the real query selects the highest run number.
    latest = max(fixture["workflow_runs"], key=lambda run: run["run_number"], default={})
    fields = (
        latest.get("status"), latest.get("conclusion"), latest.get("head_sha"),
        (latest.get("head_repository") or {}).get("full_name"),
        latest.get("event"), latest.get("head_branch"),
    )
    print("\t".join(value or "missing" for value in fields))
else:
    raise SystemExit("Unexpected GitHub API endpoint")
'''


@unittest.skipUnless(os.name != "nt" and shutil.which("bash"), "The Bash gate runs on Linux CI")
class DeploymentGateTests(unittest.TestCase):
    def run_gate(self, *, manual=False, main_sha=SHA, runs=None, overrides=None, **fixture_changes):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            binary_directory = directory / "bin"
            binary_directory.mkdir()
            fake_gh = binary_directory / "gh"
            fake_gh.write_text("#!" + sys.executable + "\n" + FAKE_GH, encoding="utf-8")
            fake_gh.chmod(0o700)
            fixture = directory / "fixture.json"
            fixture.write_text(json.dumps({
                "main_sha": main_sha,
                "workflow_runs": [ci_run()] if runs is None else runs,
                **fixture_changes,
            }), encoding="utf-8")
            output = directory / "outputs"
            summary = directory / "summary"
            log = directory / "api-calls.jsonl"
            environment = {
                "PATH": str(binary_directory) + os.pathsep + os.environ.get("PATH", os.defpath),
                "HOME": str(directory),
                "GH_TOKEN": "synthetic-token",
                "GITHUB_REPOSITORY": REPOSITORY,
                "GITHUB_OUTPUT": str(output),
                "GITHUB_STEP_SUMMARY": str(summary),
                "SOURCE_SHA": SHA,
                "EVENT_NAME": "workflow_dispatch" if manual else "workflow_run",
                "DISPATCH_REF": "refs/heads/main",
                "SOURCE_EVENT": "" if manual else "push",
                "SOURCE_CONCLUSION": "" if manual else "success",
                "SOURCE_BRANCH": "" if manual else "main",
                "SOURCE_REPOSITORY": "" if manual else REPOSITORY,
                "FAKE_GH_FIXTURE": str(fixture),
                "FAKE_GH_LOG": str(log),
            }
            environment.update(overrides or {})
            result = subprocess.run(
                [shutil.which("bash"), "--noprofile", "--norc", "-c", gate_script()],
                cwd=directory, env=environment, capture_output=True, text=True, timeout=10,
            )
            outputs = dict(
                line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines()
            ) if output.exists() else {}
            calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []
            return result, outputs, summary.read_text(encoding="utf-8") if summary.exists() else "", calls

    def assert_promoted(self, response):
        result, outputs, summary, _ = response
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(outputs, {"promote": "true", "source_sha": SHA})
        self.assertIn("Deployment selected", summary)
        self.assertIn("still need to complete", summary)

    def assert_blocked(self, response):
        result, outputs, summary, _ = response
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(outputs, {"promote": "false"})
        self.assertIn("Deployment blocked", summary)

    def test_successful_main_push_promotes_without_a_ci_lookup(self):
        response = self.run_gate()
        self.assert_promoted(response)
        self.assertEqual(len(response[3]), 1)
        self.assertTrue(any(argument.endswith("/git/ref/heads/main") for argument in response[3][0]))

    def test_untrusted_or_unsuccessful_automatic_events_skip_without_api_calls(self):
        for overrides in (
            {"SOURCE_EVENT": "pull_request"},
            {"SOURCE_CONCLUSION": "failure"},
            {"SOURCE_BRANCH": "feature"},
            {"SOURCE_REPOSITORY": "outside/fork"},
            {"SOURCE_REPOSITORY": ""},
        ):
            with self.subTest(overrides=overrides):
                result, outputs, summary, calls = self.run_gate(overrides=overrides)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(outputs, {"promote": "false"})
                self.assertIn("Deployment skipped", summary)
                self.assertEqual(calls, [])

    def test_older_automatic_commit_skips_before_packaging(self):
        result, outputs, summary, calls = self.run_gate(main_sha=OTHER_SHA)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs, {"promote": "false"})
        self.assertIn("did not upload or start an application", summary)
        self.assertEqual(len(calls), 1)

    def test_manual_main_with_successful_ci_promotes(self):
        response = self.run_gate(manual=True)
        self.assert_promoted(response)
        self.assertEqual(len(response[3]), 2)

    def test_manual_ci_lookup_is_for_exact_main_push_without_success_filter(self):
        response = self.run_gate(manual=True)
        self.assert_promoted(response)
        arguments = response[3][1]
        self.assertIn("repos/" + REPOSITORY + "/actions/workflows/ci.yml/runs", arguments)
        self.assertIn("branch=main", arguments)
        self.assertIn("event=push", arguments)
        self.assertIn("head_sha=" + SHA, arguments)
        self.assertFalse(any("status=" in argument for argument in arguments))
        query = arguments[arguments.index("--jq") + 1]
        self.assertIn("max_by(.run_number)", query)

    def test_manual_non_main_is_blocked_before_api_calls(self):
        response = self.run_gate(manual=True, overrides={"DISPATCH_REF": "refs/heads/feature"})
        self.assert_blocked(response)
        self.assertEqual(response[3], [])

    def test_manual_commit_superseded_by_main_is_blocked_before_ci_lookup(self):
        response = self.run_gate(manual=True, main_sha=OTHER_SHA)
        self.assert_blocked(response)
        self.assertEqual(len(response[3]), 1)

    def test_manual_without_ci_is_blocked(self):
        self.assert_blocked(self.run_gate(manual=True, runs=[]))

    def test_manual_failed_or_in_progress_ci_is_blocked(self):
        for run in (
            ci_run(conclusion="failure"),
            ci_run(status="in_progress", conclusion=None),
            ci_run(status="queued", conclusion=None),
            ci_run(conclusion="cancelled"),
        ):
            with self.subTest(run=run):
                self.assert_blocked(self.run_gate(manual=True, runs=[run]))

    def test_older_success_cannot_hide_latest_failure(self):
        runs = [ci_run(run_number=12, conclusion="failure"), ci_run(run_number=11)]
        response = self.run_gate(manual=True, runs=runs)
        self.assert_blocked(response)
        query = response[3][1][response[3][1].index("--jq") + 1]
        self.assertIn("max_by(.run_number)", query)

    def test_latest_success_is_used_even_when_api_order_differs(self):
        runs = [ci_run(run_number=1, conclusion="failure"), ci_run(run_number=2)]
        self.assert_promoted(self.run_gate(manual=True, runs=runs))

    def test_manual_ci_must_match_sha_repository_event_and_branch(self):
        for changes in (
            {"head_sha": OTHER_SHA},
            {"head_repository": {"full_name": "outside/fork"}},
            {"head_repository": None},
            {"event": "pull_request"},
            {"head_branch": "feature"},
        ):
            with self.subTest(changes=changes):
                self.assert_blocked(self.run_gate(manual=True, runs=[ci_run(**changes)]))

    def test_invalid_source_sha_is_blocked_without_api_calls(self):
        response = self.run_gate(overrides={"SOURCE_SHA": "invalid; echo injected"})
        self.assert_blocked(response)
        self.assertEqual(response[3], [])

    def test_unknown_event_is_blocked_without_api_calls(self):
        response = self.run_gate(overrides={"EVENT_NAME": "pull_request"})
        self.assert_blocked(response)
        self.assertEqual(response[3], [])

    def test_api_errors_never_promote(self):
        for fixture_changes in ({"main_error": True}, {"ci_error": True}):
            with self.subTest(fixture_changes=fixture_changes):
                result, outputs, _, _ = self.run_gate(manual=True, **fixture_changes)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotEqual(outputs.get("promote"), "true")


if __name__ == "__main__":
    unittest.main()
