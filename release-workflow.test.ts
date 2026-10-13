import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/publish.yml").text()) as {
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: { publish: { steps: { name: string; run?: string; if?: string; env?: Record<string, string> }[] } };
};
const steps = workflow.jobs.publish.steps;
const releaseStep = steps.find((step) => step.name === "Publish GitHub release")!;
const publishedCommit = "1953ff2f29156e6b4bc45efd678c81b7dc2c31e8";

// Execute the workflow's actual shell script with stub CLIs. No npm publication
// or GitHub request is made by these tests.
async function runRelease(options: Record<string, string> = {}) {
  const root = join(tmpdir(), "opencode");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "wakelock-release-test-"));
  const argsFile = join(directory, "release-args");
  const attemptsFile = join(directory, "npm-attempts");
  const sleepsFile = join(directory, "sleeps");
  const scripts = {
    node: `#!/bin/bash
if [[ "$*" == *".name"* ]]; then
  printf '%s\\n' opencode-wakelock
else
  printf '%s\\n' "$TEST_VERSION"
fi
`,
    npm: `#!/bin/bash
if [[ "$*" == *"gitHead"* ]]; then
  attempt=0
  if [[ -f "$TEST_ATTEMPTS_FILE" ]]; then
    read -r attempt < "$TEST_ATTEMPTS_FILE"
  fi
  attempt=$((attempt + 1))
  printf '%s\\n' "$attempt" > "$TEST_ATTEMPTS_FILE"
  if [[ "$TEST_NPM_FAILURE" == true || "$attempt" -le "$TEST_NPM_FAILURES" ]]; then
    exit 1
  fi
  printf '%s\\n' "$TEST_COMMIT"
else
  printf '%s\\n' "$TEST_LATEST"
fi
`,
    sleep: `#!/bin/bash
printf '%s\\n' "$1" >> "$TEST_SLEEPS_FILE"
`,
    gh: `#!/bin/bash
if [[ "$2" == view ]]; then
  [[ "$TEST_EXISTS" == true ]]
else
  printf '%s\\n' "$@" > "$TEST_ARGS_FILE"
  if [[ "$TEST_GH_FAILURE" == true ]]; then
    exit 1
  fi
fi
`,
  };
  try {
    for (const [name, script] of Object.entries(scripts)) {
      await Bun.write(join(directory, name), script);
      await chmod(join(directory, name), 0o755);
    }
    const process = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", releaseStep.run!], {
      env: {
        PATH: `${directory}:/usr/bin:/bin`,
        GITHUB_REPOSITORY: "IgnisDa/opencode-wakelock",
        TEST_VERSION: "0.3.0",
        TEST_LATEST: "0.3.0",
        TEST_COMMIT: publishedCommit,
        TEST_NPM_FAILURES: "0",
        TEST_ARGS_FILE: argsFile,
        TEST_ATTEMPTS_FILE: attemptsFile,
        TEST_SLEEPS_FILE: sleepsFile,
        ...options,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    const args = await Bun.file(argsFile).exists()
      ? (await Bun.file(argsFile).text()).trimEnd().split("\n")
      : [];
    const attempts = await Bun.file(attemptsFile).exists()
      ? Number(await Bun.file(attemptsFile).text())
      : 0;
    const sleeps = await Bun.file(sleepsFile).exists()
      ? (await Bun.file(sleepsFile).text()).trimEnd().split("\n")
      : [];
    return { args, stdout, stderr, exitCode, attempts, sleeps };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("GitHub release follows npm publication and can recover on rerun", () => {
  const publishIndex = steps.findIndex((step) => step.name === "Publish to npm");
  expect(steps.indexOf(releaseStep)).toBeGreaterThan(publishIndex);
  expect(releaseStep.if).toBeUndefined();
  expect(releaseStep.env?.GH_TOKEN).toBe("${{ github.token }}");
  expect(workflow.permissions["contents"]).toBe("write");
  expect(workflow.permissions["id-token"]).toBe("write");
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
});

test("creates the latest release at npm's published commit with generated notes", async () => {
  const result = await runRelease();
  expect(result.exitCode).toBe(0);
  expect(result.args.slice(0, 3)).toEqual(["release", "create", "v0.3.0"]);
  expect(result.args[result.args.indexOf("--target") + 1]).toBe(publishedCommit);
  expect(result.args[result.args.indexOf("--repo") + 1]).toBe("IgnisDa/opencode-wakelock");
  expect(result.args).toContain("--generate-notes");
  expect(result.args).toContain("--latest");
  expect(result.args).toContain("Published to npm: https://www.npmjs.com/package/opencode-wakelock/v/0.3.0");
});

test("an existing GitHub release is skipped", async () => {
  const result = await runRelease({ TEST_EXISTS: "true" });
  expect(result.exitCode).toBe(0);
  expect(result.args).toEqual([]);
  expect(result.stdout).toContain("already exists");
});

test("recovering an older version does not replace the latest release", async () => {
  const result = await runRelease({ TEST_LATEST: "0.4.0" });
  expect(result.exitCode).toBe(0);
  expect(result.args).toContain("--latest=false");
  expect(result.args).not.toContain("--latest");
});

test("prereleases are marked and never replace the latest stable release", async () => {
  const result = await runRelease({ TEST_VERSION: "0.4.0-beta.1", TEST_LATEST: "0.4.0-beta.1" });
  expect(result.exitCode).toBe(0);
  expect(result.args).toContain("v0.4.0-beta.1");
  expect(result.args).toContain("--prerelease");
  expect(result.args).toContain("--latest=false");
});

test("missing published commit fails instead of tagging unpublished code", async () => {
  const result = await runRelease({ TEST_COMMIT: "" });
  expect(result.exitCode).not.toBe(0);
  expect(result.args).toEqual([]);
  expect(result.stderr).toContain("Cannot determine the published commit");
});

test("npm lookup failure prevents release creation", async () => {
  const result = await runRelease({ TEST_NPM_FAILURE: "true" });
  expect(result.exitCode).not.toBe(0);
  expect(result.args).toEqual([]);
  expect(result.attempts).toBe(30);
  expect(result.sleeps).toHaveLength(29);
});

test("waits for a newly published npm version to become visible", async () => {
  const result = await runRelease({ TEST_NPM_FAILURES: "2" });
  expect(result.exitCode).toBe(0);
  expect(result.attempts).toBe(3);
  expect(result.sleeps).toEqual(["10", "10"]);
  expect(result.args).toContain("create");
  expect(result.args[result.args.indexOf("--target") + 1]).toBe(publishedCommit);
});

test("GitHub publication failure fails the workflow", async () => {
  const result = await runRelease({ TEST_GH_FAILURE: "true" });
  expect(result.exitCode).not.toBe(0);
  expect(result.args).toContain("create");
});
