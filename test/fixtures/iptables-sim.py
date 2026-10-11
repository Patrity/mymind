#!/usr/bin/env python3
# Test double for `iptables` / `iptables-restore` (network.test.ts): a tiny in-file filter table.
# State lives in $IPT_STATE (JSON); after EVERY mutating invocation the full `iptables -S` text is
# appended to $IPT_SNAPSHOTS (separated by "=====") so a test can check there was never an
# unfiltered moment. `iptables-restore --noflush` applies its whole transaction at once, like the
# kernel does. Only the subset install-network.sh uses is implemented.
import json, os, sys

STATE, SNAPS = os.environ['IPT_STATE'], os.environ['IPT_SNAPSHOTS']
BUILTIN = ['INPUT', 'FORWARD', 'OUTPUT']


def load():
    with open(STATE) as f:
        return json.load(f)


def save(st):
    with open(STATE, 'w') as f:
        json.dump(st, f)
    with open(SNAPS, 'a') as f:
        f.write(dump(st) + '\n=====\n')


def dump(st, chain=None):
    names = [chain] if chain else st['order']
    out = []
    for c in names:
        out.append(f'-P {c} ACCEPT' if c in BUILTIN else f'-N {c}')
    for c in names:
        out += [f'-A {c} {r}' for r in st['chains'][c]]
    return '\n'.join(out)


def main(argv):
    prog = os.path.basename(argv[0])
    st = load()
    ch = st['chains']
    if prog == 'iptables-restore':
        assert '--noflush' in argv, 'install-network.sh must never flush the whole table'
        new = json.loads(json.dumps(st))
        for line in sys.stdin.read().splitlines():
            line = line.strip()
            if not line or line.startswith('#') or line in ('*filter', 'COMMIT'):
                continue
            if line.startswith(':'):
                name = line[1:].split()[0]
                if name not in new['chains']:
                    new['chains'][name] = []
                    new['order'].append(name)
                elif name not in BUILTIN:
                    new['chains'][name] = []  # a declared user chain is flushed (inside the transaction)
            elif line.startswith('-A '):
                _, c, *rest = line.split()
                if c not in new['chains']:
                    return 1
                new['chains'][c].append(' '.join(rest))
            else:
                return 2
        save(new)
        return 0
    op, c, *rest = argv[1:] + [None] * (2 - len(argv[1:]))
    rest = [r for r in rest if r is not None]
    if op == '-S':
        if c is not None and c not in ch:
            return 1
        print(dump(st, c))
        return 0
    if c not in ch and op != '-N':
        return 1
    rule = ' '.join(rest)
    if op == '-C':
        return 0 if rule in ch[c] else 1
    if op == '-N':
        if c in ch:
            return 1
        ch[c] = []
        st['order'].append(c)
    elif op == '-F':
        ch[c] = []
    elif op == '-A':
        ch[c].append(rule)
    elif op == '-I':
        pos = 1
        if rest and rest[0].isdigit():
            pos, rule = int(rest[0]), ' '.join(rest[1:])
        ch[c].insert(pos - 1, rule)
    elif op == '-D':
        if len(rest) == 1 and rest[0].isdigit():
            del ch[c][int(rest[0]) - 1]
        elif rule in ch[c]:
            ch[c].remove(rule)
        else:
            return 1
    else:
        return 2
    save(st)
    return 0


sys.exit(main(sys.argv))
