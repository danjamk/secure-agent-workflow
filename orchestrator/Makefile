.PHONY: check test-security deploy connect health

# The pre-PR gate. The root Makefile runs this.
check:
	pnpm install --frozen-lockfile --ignore-scripts
	pnpm check

test-security:
	pnpm test:security

# Run by a human with the factory token in .env.local, until CI deploys this.
deploy:
	bash deploy.sh

connect:
	bash connect-app.sh

# Asserts the live Worker matches this checkout.
health:
	bash deploy.sh --health
