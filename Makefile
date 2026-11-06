.PHONY: check decisions

# The pre-PR gate, and what the gate's check job runs on this repo.
check:
	python3 -m unittest discover -s gate
	python3 -m unittest discover -s deploy/credentials
	python3 -m unittest discover -s deploy/cloudflare
	$(MAKE) -C orchestrator check
	$(MAKE) -C console check
	@for f in $$(git ls-files '*.sh'); do bash -n "$$f" || exit 1; done
	@echo "Shell syntax OK."

# Every decision, oldest first. The folder is the record; this view isn't committed,
# so PRs that add decisions never touch the same file.
decisions:
	@for f in docs/decisions/2*.md; do cat "$$f"; echo; done
