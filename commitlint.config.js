// Conventional commits with a mandatory scope (any scope allowed).
// Valid: feat(auth): ..., fix(quota): ...
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-empty": [2, "never"],
    "scope-case": [2, "always", "kebab-case"],
  },
};
