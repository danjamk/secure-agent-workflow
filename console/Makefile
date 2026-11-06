.PHONY: check deploy

# The pre-PR gate. The root Makefile runs this.
check:
	pnpm install --frozen-lockfile --ignore-scripts
	pnpm check

# console-deploy.yml runs this on merge. By hand, it needs a factory token.
deploy:
	bash deploy.sh
