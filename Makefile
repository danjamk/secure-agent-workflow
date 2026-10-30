.PHONY: check

# The pre-PR gate, and what the gate's check job runs on this repo.
check:
	python3 -m unittest discover -s gate
	@for f in $$(git ls-files '*.sh'); do bash -n "$$f" || exit 1; done
	@echo "Shell syntax OK."
