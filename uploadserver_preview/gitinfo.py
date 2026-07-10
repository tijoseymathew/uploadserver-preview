"""uploadserver-preview — read-only git integration.

Shells out to git in the directory being *browsed* (not the served root — the
served tree may contain repositories anywhere below it) to answer two
questions for the explorer UI: "what changed on this branch vs a compare
base?" (`status`, behind `/__git__`) and "what is the diff for one file?"
(`file_diff`, behind `/__diff__`). Repository discovery is git's own: it walks
up from `root` to the enclosing work tree, so browsing a subdirectory of a
repo works too.

Everything fails soft: outside a repository, with git missing, or on any git
error the callers get None/"" and the UI simply hides its git surfaces. Only
read-only git commands are ever run, and the compare base is validated against
the repo's actual branch list, so no request-supplied string reaches git as
anything but a checked ref name or a `--`-guarded path.

Reported paths are relative to `root` (git runs with `-C <root>` and
`--relative`), which also scopes the change map to that subtree.
"""

import os
import re
import subprocess

__all__ = ["head_label", "ignored_names", "status", "file_diff"]

_GIT_TIMEOUT = 5           # seconds; git on a local repo is normally instant
_SHORTSTAT_RE = re.compile(r"(\d+) insertion|(\d+) deletion")


def _run(root, *args, ok_returncodes=(0,), input=None):
    """Run a read-only git command in `root`; stdout str, or None on any failure."""
    try:
        p = subprocess.run(
            ("git", "-C", root) + args,
            capture_output=True,
            timeout=_GIT_TIMEOUT,
            input=input.encode("utf-8", "surrogateescape") if input is not None else None,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode not in ok_returncodes:
        return None
    return p.stdout.decode("utf-8", "surrogateescape")


def _head(root):
    """(label, detached) for HEAD — a branch name or a short SHA — or (None, False)."""
    out = _run(root, "rev-parse", "--abbrev-ref", "HEAD")
    if out is None:
        return None, False
    name = out.strip()
    if name != "HEAD":
        return name, False
    sha = _run(root, "rev-parse", "--short", "HEAD")
    return (sha.strip() if sha else None), True


def head_label(root):
    """The branch name (or short SHA when detached), or None outside a repo.

    Used to server-render the context chip; cheap enough to call per listing.
    """
    return _head(root)[0]


def ignored_names(root, names):
    """The subset of `names` (entries of the directory `root`) that gitignore
    rules exclude, as a set. Empty outside a repo or on any git failure.

    Names go to git over stdin (never as arguments), so arbitrary filenames are
    safe. check-ignore exits 1 when nothing matched — still a success here.
    """
    names = [n for n in names if n]
    if not names:
        return set()
    out = _run(root, "check-ignore", "--stdin", "-z",
               ok_returncodes=(0, 1), input="\0".join(names))
    if not out:
        return set()
    return {n for n in out.split("\0") if n}


def _repo_scope(root, boundary):
    """(effective_root, url_prefix) for the repo enclosing `root`.

    effective_root is the repo toplevel clamped to `boundary` (the served
    root) so change maps never reach above the served tree; url_prefix is its
    URL path relative to boundary ("/" when they coincide). Keys in the change
    map are relative to effective_root, so badges cover the whole repo no
    matter which of its subdirectories the client asked about.
    """
    top = _run(root, "rev-parse", "--show-toplevel")
    eff = root
    if top and top.strip():
        top = os.path.realpath(top.strip())
        eff = top if (top == boundary or top.startswith(boundary + os.sep)) else boundary
    rel = os.path.relpath(eff, boundary)
    prefix = "/" if rel == "." else "/" + rel.replace(os.sep, "/") + "/"
    return eff, prefix


def _branches(root):
    out = _run(root, "branch", "--format=%(refname:short)")
    if out is None:
        return []
    return [b for b in (line.strip() for line in out.splitlines()) if b]


def _pick_base(requested, branches, head):
    """The compare base: the validated request, else the current branch.

    Defaulting to the branch itself means the default view is "uncommitted
    changes only" — comparing against another branch is an explicit choice.
    "HEAD" is always legal too (equivalent for an attached HEAD, and the
    default when detached).
    """
    if requested and (requested in branches or requested == "HEAD"):
        return requested
    return head if head in branches else "HEAD"


def _changes(root, base):
    """{relpath: "M"|"A"|"D"} vs `base`, including untracked files as "A"."""
    changes = {}
    out = _run(root, "diff", "--name-status", "-z", "--no-renames", "--relative", base, "--")
    if out is not None:
        toks = out.split("\0")
        for i in range(0, len(toks) - 1, 2):
            st, path = toks[i][:1], toks[i + 1]
            if not st or not path:
                continue
            changes[path] = st if st in ("M", "A", "D") else "M"
    out = _run(root, "ls-files", "--others", "--exclude-standard", "-z")
    if out is not None:
        for path in out.split("\0"):
            if path:
                changes.setdefault(path, "A")
    return changes


def _counts(root, base):
    """(insertions, deletions) vs `base` over tracked files."""
    out = _run(root, "diff", "--shortstat", "--relative", base, "--")
    if not out:
        return 0, 0
    ins = dels = 0
    for m in _SHORTSTAT_RE.finditer(out):
        if m.group(1):
            ins = int(m.group(1))
        if m.group(2):
            dels = int(m.group(2))
    return ins, dels


def status(root, base=None, boundary=None):
    """The /__git__ payload for the repo enclosing `root`, or None outside one.

    {branch, detached, base, branches, prefix, changes: {relpath: M|A|D},
     insertions, deletions} — `prefix` is the repo's URL path under `boundary`
    (the served root; defaults to `root`) and the change map is relative to it.
    """
    head, detached = _head(root)
    if head is None:
        return None
    boundary = os.path.realpath(boundary) if boundary else root
    eff, prefix = _repo_scope(root, boundary)
    branches = _branches(eff)
    base = _pick_base(base, branches, head)
    ins, dels = _counts(eff, base)
    return {
        "branch": head,
        "detached": detached,
        "base": base,
        "branches": branches,
        "prefix": prefix,
        "changes": _changes(eff, base),
        "insertions": ins,
        "deletions": dels,
    }


def file_diff(root, relpath, base=None):
    """Unified diff for one file vs the compare base, or "" when unchanged/invalid.

    `relpath` must already be validated to live inside the served root; it is
    still passed behind `--` so it can never be parsed as an option. Untracked
    files get a synthesised new-file diff via `git diff --no-index`.
    """
    head, _ = _head(root)
    if head is None or not relpath or relpath.startswith("-"):
        return ""
    base = _pick_base(base, _branches(root), head)
    out = _run(root, "diff", "--relative", base, "--", relpath)
    if out:
        return out
    tracked = _run(root, "ls-files", "--error-unmatch", "--", relpath)
    if tracked is not None:
        return ""  # tracked but unchanged
    # untracked: synthesise an all-added diff (--no-index exits 1 on differences)
    out = _run(root, "diff", "--no-index", "--", "/dev/null", relpath,
               ok_returncodes=(0, 1))
    return out or ""
