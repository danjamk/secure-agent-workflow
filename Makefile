.PHONY: check

# The pre-PR gate, and what the gate's check job runs on this repo.
check:
	python3 -m unittest discover -s gate
	python3 -m unittest discover -s deploy/credentials
	python3 -m unittest discover -s deploy/cloudflare
	@for f in $$(git ls-files '*.sh'); do bash -n "$$f" || exit 1; done
	@echo "Shell syntax OK."
