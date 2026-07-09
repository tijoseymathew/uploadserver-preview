# Tests

`test_viewer.js` and `test_edge.js` run the real `viewer.js` inside jsdom against
sample files, verifying each renderer produces the expected DOM.

```bash
npm install jsdom        # dev-only; not a runtime dependency
# create sample files under /tmp/serve_test (see the harness), then:
node tests/test_viewer.js
node tests/test_edge.js
```
