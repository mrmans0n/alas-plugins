# Import fixtures

The Xcode JSON files were captured on 2026-10-16 with Xcode 27.0, build 27A266a,
xcresulttool 25115, schema 0.4.0. Only the device ID and absolute source path were
replaced with stable fixture values. Durations, parameter URLs, repetitions,
failures and skips are the tool's actual output.

The tiny macOS XCTest bundle contained a passing assertion, a deliberately failing
assertion and an XCTSkip. The parameterized fixture also contained a Swift Testing
`@Test(arguments: ["first", "second"])` that fails for `second`.

The capture used `xcodebuild test -retry-tests-on-failure -test-iterations 2` with
an explicit resultBundlePath. JSON was extracted using:

```sh
xcrun xcresulttool get test-results tests --path Result.xcresult --compact
xcrun xcresulttool get test-results summary --path Result.xcresult --compact
xcrun xcresulttool get test-results test-details --path Result.xcresult \
  --test-id 'ExplorerFixture/testFailure()' --compact
xcrun xcresulttool get test-results test-details --path Result.xcresult \
  --test-id 'ParameterizedFixture/parameterized(_:)' --compact
```

`junit.xml` is a representative Gradle/JUnit-style fixture combining nested
aggregate suites, parameterized display names, repeated identities, failures,
errors, a skip and missing duration. Its deliberately inconsistent aggregate
attributes verify that counts come from leaf testcases.
