import copy
import json
import math
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load_helper():
    namespace = {"__name__": "explorer_tests", "__file__": str(ROOT / "dist/capture.py")}
    program = ROOT / "dist/capture.py"
    if program.exists():
        exec(compile(program.read_text(), str(program), "exec"), namespace)
    return namespace


class HelperTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.helper = load_helper()

    def function(self, name):
        self.assertTrue(callable(self.helper.get(name)), "missing implementation: " + name)
        return self.helper[name]

    def test_junit_counts_leaf_cases_and_preserves_unordered_attempts(self):
        text = (ROOT / "tests/fixtures/junit.xml").read_text()
        rows = self.function("parse_junit")(text, "junit-evidence")
        self.assertEqual(len(rows), 5)
        self.assertEqual([row["status"] for row in rows], ["failed", "passed", "skipped", "error", "passed"])
        self.assertEqual(rows[0]["id"], rows[1]["id"])
        self.assertNotEqual(rows[0]["attempt"], rows[1]["attempt"])
        self.assertIn("[zero, unicode β]", rows[0]["name"])
        self.assertEqual(rows[0]["duration"], 0.25)
        self.assertNotIn("duration", rows[2])
        self.assertEqual(rows[0]["source"], {"path": "src/Example.kt", "line": 12})
        self.assertIn("expected <2>", rows[0]["failure"])
        self.assertEqual(rows[0]["evidence"]["artifact"], "junit-evidence")

    def test_xml_dtd_entities_malformed_and_nonfinite_duration_are_not_success(self):
        parse = self.function("parse_junit")
        for text in ['<!DOCTYPE testsuite [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuite/>',
                     '<testsuite><testcase name="x"></testsuite>', '<other/>']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse(text, "a")
        rows = parse('<testsuite><testcase name="x" time="NaN"/></testsuite>', "a")
        self.assertNotIn("duration", rows[0])

    def benchmark(self, **overrides):
        measurement = {"id": "sort", "parameters": {"size": 100}, "metric": "wall", "value": 10,
                       "unit": "ms", "direction": "lower", "statistic": "median", "samples": [9, 10, 11]}
        measurement.update(overrides)
        return measurement

    def result(self, **overrides):
        result = {"schema": 1, "id": "capture", "complete": True, "tests": [], "benchmarks": [],
                  "artifacts": [], "issues": [], "conditions": {"host": "machine", "toolchain": "Swift 6",
                  "configuration": "release", "target": "arm64"}, "source": {"state": "unknown"}}
        result.update(overrides)
        return result

    def test_benchmark_schema_validation_and_parameters(self):
        parse = self.function("parse_benchmarks")
        document = {"format": "alas-benchmarks", "version": 1, "measurements": [self.benchmark()]}
        rows = parse(json.dumps(document), "a")
        self.assertEqual(rows[0]["value"], 10)
        self.assertEqual(rows[0]["samples"], [9, 10, 11])
        for key, value in [("value", float("nan")), ("direction", "fast"), ("samples", [float("inf")])]:
            bad = copy.deepcopy(document)
            bad["measurements"][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                parse(json.dumps(bad), "a")
        document["version"] = 2
        with self.assertRaises(ValueError):
            parse(json.dumps(document), "a")

    def test_benchmark_comparison_compatibility_zero_and_raw_values(self):
        compare = self.function("compare_results")
        base = self.result(benchmarks=[self.benchmark(value=0)])
        current = self.result(benchmarks=[self.benchmark(value=2)])
        row = compare(base, current)["benchmarks"][0]
        self.assertTrue(row["compatible"])
        self.assertEqual(row["absolute"], 2)
        self.assertIsNone(row["percent"])
        self.assertEqual(row["baseline"], 0)
        self.assertEqual(row["current"], 2)
        self.assertEqual(row["significance"], "not assessed")
        base["benchmarks"][0]["value"] = 10
        row = compare(base, current)["benchmarks"][0]
        self.assertEqual(row["percent"], -80)
        for field in ["host", "toolchain", "configuration", "target"]:
            bad = copy.deepcopy(current)
            bad["conditions"][field] = "other"
            row = compare(base, bad)["benchmarks"][0]
            self.assertFalse(row["compatible"])
            self.assertNotIn("absolute", row)
        for field in ["unit", "statistic", "parameters"]:
            bad = copy.deepcopy(current)
            bad["benchmarks"][0][field] = {"size": 200} if field == "parameters" else "different"
            self.assertTrue(all(not r["compatible"] for r in compare(base, bad)["benchmarks"]))

    def test_test_comparison_retries_skips_absence_and_incomplete_reports(self):
        compare = self.function("compare_results")
        def case(identity, status, **fields):
            return {"id": identity, "name": identity, "suite": [], "status": status, **fields}
        base = self.result(tests=[case("retry[x]", "failed"), case("retry[x]", "passed"),
                                  case("removed", "skipped"), case("regression", "passed", duration=1)])
        current = self.result(tests=[case("retry[x]", "passed"), case("added", "skipped"),
                                     case("regression", "failed", duration=3)])
        changes = {r["id"]: r for r in compare(base, current)["tests"]}
        self.assertEqual(changes["retry[x]"]["change"], "recovered")
        self.assertEqual(changes["regression"]["change"], "newly failing")
        self.assertEqual(changes["regression"]["durationDelta"], 2)
        self.assertEqual(changes["removed"]["change"], "removed")
        self.assertEqual(changes["added"]["change"], "added")
        self.assertNotIn("durationDelta", changes["retry[x]"])
        current["complete"] = False
        changes = {r["id"]: r for r in compare(base, current)["tests"]}
        self.assertEqual(changes["removed"]["change"], "unknown")
        self.assertEqual(changes["retry[x]"]["change"], "unknown")
        self.assertEqual(changes["regression"]["change"], "unknown")
        self.assertNotIn("durationDelta", changes["regression"])
        current["complete"], base["complete"] = True, False
        changes = {r["id"]: r for r in compare(base, current)["tests"]}
        self.assertEqual(changes["retry[x]"]["change"], "unknown")
        self.assertEqual(changes["regression"]["change"], "unknown")
        self.assertNotIn("durationDelta", changes["regression"])

    def test_artifact_import_deduplicates_paths_and_reports_missing_without_green(self):
        importer = self.function("import_artifacts")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.joinpath("a.xml").write_text((ROOT / "tests/fixtures/junit.xml").read_text())
            imported = importer(root, [{"path": "a.xml", "format": "junit"},
                                       {"path": "a.xml", "format": "junit"},
                                       {"path": "missing.xml", "format": "junit"}])
            self.assertEqual(len(imported["tests"]), 5)
            self.assertFalse(imported["complete"])
            self.assertTrue(imported["issues"])
            self.assertEqual(len(imported["artifacts"]), 1)
            empty = importer(root, [])
            self.assertFalse(empty["complete"])
            self.assertEqual(empty["tests"], [])

    def test_real_xcode_fixture_preserves_repetitions_and_locations(self):
        parse = self.function("parse_xcresult")
        fixtures = ROOT / "tests/fixtures"
        tree = json.loads(fixtures.joinpath("xcode-tests.json").read_text())
        detail = json.loads(fixtures.joinpath("xcode-detail.json").read_text())
        rows = parse(tree, {detail["testIdentifierURL"]: detail}, "xcresult-evidence")
        self.assertEqual(len(rows), 4)
        failed = [r for r in rows if r["status"] == "failed"]
        self.assertEqual(len(failed), 2)
        self.assertEqual(failed[0]["id"], failed[1]["id"])
        self.assertNotEqual(failed[0]["attempt"], failed[1]["attempt"])
        self.assertEqual(failed[0]["source"], {"path": "Sources/Tests.swift", "line": 4})
        self.assertIn("representative captured failure", failed[0]["failure"])
        self.assertTrue(all("duration" in r for r in rows))
        self.assertEqual(sum(r["status"] == "skipped" for r in rows), 1)

    def test_real_xcode_parameters_do_not_merge_or_multiply_attempts(self):
        fixtures = ROOT / "tests/fixtures"
        tree = json.loads(fixtures.joinpath("xcode-parameters-tests.json").read_text())
        detail = json.loads(fixtures.joinpath("xcode-parameters-detail.json").read_text())
        rows = self.function("parse_xcresult")(tree, {detail["testIdentifierURL"]: detail}, "a")
        parameters = [r for r in rows if "parameterized" in r["name"]]
        self.assertEqual(len(parameters), 3)
        self.assertEqual(len(set(r["id"] for r in parameters)), 2)
        passing = next(r for r in parameters if r["status"] == "passed")
        self.assertIn('"first"', passing["name"])
        self.assertAlmostEqual(passing["duration"], 6.413459777832031e-05)
        self.assertIn("?args=", passing["evidence"]["selector"])

    def test_xcode_destination_and_configuration_are_part_of_identity(self):
        tree = {"testNodes": [{"nodeType": "Test Case", "name": "test()", "nodeIdentifierURL": "test://suite/test",
                 "children": [{"nodeType": "Device", "name": device, "children": [
                    {"nodeType": "Test Plan Configuration", "name": configuration, "result": "Passed"}
                    for configuration in ["Debug", "Release"]]} for device in ["Mac", "iPhone"]]}]}
        rows = self.function("parse_xcresult")(tree, {}, "a")
        self.assertEqual(len(rows), 4)
        self.assertEqual(len(set(r["id"] for r in rows)), 4)

    def test_extreme_finite_benchmark_values_and_unicode_briefs_stay_encodable(self):
        base = self.result(benchmarks=[self.benchmark(value=-1e308)])
        current = self.result(benchmarks=[self.benchmark(value=1e308)])
        compared = self.function("compare_results")(base, current)
        json.dumps(compared, allow_nan=False)
        result = self.result(tests=[{"id": "x", "name": "x", "status": "failed", "failure": "β" * 100000}])
        brief = self.function("investigation_brief")(result)
        self.assertLessEqual(len(brief.encode("utf-8")), 65536)

    def test_investigation_brief_can_select_measurements(self):
        result = self.result(benchmarks=[self.benchmark(id="unselected"), self.benchmark(id="selected")])
        brief = self.function("investigation_brief")(result, selected_benchmarks=[1])
        self.assertIn('"id":"selected"', brief)
        self.assertNotIn('"id":"unselected"', brief)

    def test_benchmark_page_keeps_value_and_full_sample_count(self):
        result = self.result(benchmarks=[self.benchmark(samples=[1e308] * 10000)])
        page = self.function("query_result")(result, {"kind": "benchmarks", "status": "failed"})
        self.assertEqual(len(page["rows"]), 1)
        self.assertEqual(page["rows"][0]["value"], 10)
        self.assertEqual(page["rows"][0]["sampleCount"], 10000)
        self.assertEqual(page["rows"][0]["rowIndex"], 0)


if __name__ == "__main__":
    unittest.main()
