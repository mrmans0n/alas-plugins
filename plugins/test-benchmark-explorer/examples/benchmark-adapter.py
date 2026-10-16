#!/usr/bin/env python3
"""Replace measure() with a project benchmark. No console-output parsing required."""
import json
import os
from pathlib import Path
import statistics
import time


def measure():
    start = time.perf_counter()
    sorted(range(10000, 0, -1))
    return (time.perf_counter() - start) * 1000


samples = [measure() for _ in range(10)]
document = {"format": "alas-benchmarks", "version": 1, "measurements": [{
    "id": "sort", "parameters": {"size": 10000}, "metric": "wall-time",
    "value": statistics.median(samples), "unit": "ms", "direction": "lower",
    "statistic": "median", "samples": samples,
}]}
Path(os.environ["ALAS_RESULTS_DIR"], "benchmarks.json").write_text(json.dumps(document))
