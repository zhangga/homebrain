NPM_REGISTRY ?= https://registry.npmjs.org/
PACKAGE_NAME := $(shell node -p "require('./package.json').name")

.DEFAULT_GOAL := help

.PHONY: help check-token whoami check pack publish-dry-run publish view

help: ## Show available commands.
	@awk 'BEGIN { FS = ":.*## "; printf "Usage: make <target>\n\nTargets:\n" } /^[a-zA-Z0-9_-]+:.*## / { printf "  %-18s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

check-token: ## Verify NPM_TOKEN is present in the environment.
	@if [ -z "$${NPM_TOKEN:-}" ]; then \
		echo "NPM_TOKEN is required. Example: NPM_TOKEN=npm_xxx make publish"; \
		exit 1; \
	fi
	@echo "NPM_TOKEN is set."

whoami: check-token ## Verify the token can authenticate with npm.
	@set -eu; \
	tmp_npmrc="$$(mktemp)"; \
	trap 'rm -f "$$tmp_npmrc"' EXIT INT TERM; \
	printf '%s\n' \
		"registry=$(NPM_REGISTRY)" \
		"//registry.npmjs.org/:_authToken=$$NPM_TOKEN" \
		> "$$tmp_npmrc"; \
	NPM_CONFIG_USERCONFIG="$$tmp_npmrc" npm whoami --registry "$(NPM_REGISTRY)"

check: ## Run local package checks before publishing.
	npm test
	npm pack --dry-run

pack: ## Preview the package tarball contents without creating a release.
	npm pack --dry-run

publish-dry-run: check-token check whoami ## Simulate npm publish using NPM_TOKEN.
	@set -eu; \
	tmp_npmrc="$$(mktemp)"; \
	trap 'rm -f "$$tmp_npmrc"' EXIT INT TERM; \
	printf '%s\n' \
		"registry=$(NPM_REGISTRY)" \
		"//registry.npmjs.org/:_authToken=$$NPM_TOKEN" \
		> "$$tmp_npmrc"; \
	NPM_CONFIG_USERCONFIG="$$tmp_npmrc" npm publish --dry-run --access public --registry "$(NPM_REGISTRY)"

publish: check-token check whoami ## Publish the package to npm using NPM_TOKEN.
	@set -eu; \
	tmp_npmrc="$$(mktemp)"; \
	trap 'rm -f "$$tmp_npmrc"' EXIT INT TERM; \
	printf '%s\n' \
		"registry=$(NPM_REGISTRY)" \
		"//registry.npmjs.org/:_authToken=$$NPM_TOKEN" \
		> "$$tmp_npmrc"; \
	NPM_CONFIG_USERCONFIG="$$tmp_npmrc" npm publish --access public --registry "$(NPM_REGISTRY)"

view: ## Show the published package metadata from npm.
	npm view "$(PACKAGE_NAME)" name version description --registry "$(NPM_REGISTRY)"
