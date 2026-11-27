// Conventional Commits: https://www.conventionalcommits.org/
export default {
  extends: ["@commitlint/config-conventional"],
  // Dependabot writes release notes into the body with lines longer than the
  // limit; its subject line still follows the configured prefix.
  ignores: [(message) => message.includes("dependabot[bot]")],
};
