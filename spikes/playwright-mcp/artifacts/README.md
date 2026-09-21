# Experimental artifacts

`primary-attempts.json` records the environment limitation before exploration
began. It intentionally contains no answer-key identity, DOM source, selector,
or invented browser interaction.

`oracle-results.json` is generated locally by `oracle/score.py`. The answer key
it uses stays under `oracle/` and is excluded from the fixture server root.
