#!/usr/bin/env python3
"""
Add a `classify` field (SIZE=1, TYPE=U, COUNT=1, default value 0) after the
`timestamp` field in every binary PCD file under a given root directory.

Target header:
    FIELDS x y z intensity ring timestamp classify
    SIZE 4 4 4 4 2 8 1
    TYPE F F F F U F U
    COUNT 1 1 1 1 1 1 1

Original header (expected):
    FIELDS x y z intensity ring timestamp
    SIZE 4 4 4 4 2 8
    TYPE F F F F U F
    COUNT 1 1 1 1 1 1

Files that already contain `classify` in FIELDS are left untouched.
Only binary-format PCDs are modified in place.
"""

import os
import sys
import argparse


ORIG_POINT_SIZE = 4 + 4 + 4 + 4 + 2 + 8  # 26 bytes
NEW_POINT_SIZE = ORIG_POINT_SIZE + 1     # 27 bytes


def read_header(fp):
    """Read text header lines until DATA line (inclusive). Returns
    (header_lines, header_bytes_len)."""
    header_lines = []
    total = 0
    while True:
        line = fp.readline()
        if not line:
            raise ValueError('unexpected EOF while reading header')
        total += len(line)
        header_lines.append(line.decode('ascii', errors='replace').rstrip('\r\n'))
        if header_lines[-1].startswith('DATA'):
            break
    return header_lines, total


def parse_header(header_lines):
    info = {}
    for ln in header_lines:
        if not ln or ln.startswith('#'):
            continue
        parts = ln.split()
        if not parts:
            continue
        key = parts[0].upper()
        info[key] = parts[1:]
    return info


def build_new_header(header_lines):
    """Return new header text (bytes) with classify field appended, preserving
    other header lines in order."""
    out = []
    for ln in header_lines:
        if not ln:
            out.append(ln)
            continue
        upper = ln.split(None, 1)[0].upper() if ln.split() else ''
        if upper == 'FIELDS':
            out.append('FIELDS x y z intensity ring timestamp classify')
        elif upper == 'SIZE':
            out.append('SIZE 4 4 4 4 2 8 1')
        elif upper == 'TYPE':
            out.append('TYPE F F F F U F U')
        elif upper == 'COUNT':
            out.append('COUNT 1 1 1 1 1 1 1')
        else:
            out.append(ln)
    return ('\n'.join(out) + '\n').encode('ascii')


def process_file(path, dry_run=False):
    with open(path, 'rb') as fp:
        header_lines, header_len = read_header(fp)
        body = fp.read()

    info = parse_header(header_lines)
    fields = info.get('FIELDS', [])
    data_line = next((ln for ln in header_lines if ln.startswith('DATA')), '')
    data_fmt = data_line.split()[1].lower() if len(data_line.split()) > 1 else ''

    if 'classify' in fields:
        return 'skip_has_classify'

    if data_fmt != 'binary':
        return f'skip_non_binary({data_fmt})'

    expected_fields = ['x', 'y', 'z', 'intensity', 'ring', 'timestamp']
    if fields != expected_fields:
        return f'skip_unexpected_fields({fields})'

    try:
        points = int(info['POINTS'][0])
    except (KeyError, ValueError, IndexError):
        return 'skip_no_points'

    expected_body = points * ORIG_POINT_SIZE
    if len(body) < expected_body:
        return f'skip_body_short(have={len(body)},need={expected_body})'

    # Some producers pad the file; keep only the exact point payload.
    payload = body[:expected_body]
    trailing = body[expected_body:]  # usually empty

    # Insert a zero byte at the end of each point record.
    zero = b'\x00'
    new_payload = bytearray(points * NEW_POINT_SIZE)
    for i in range(points):
        src = i * ORIG_POINT_SIZE
        dst = i * NEW_POINT_SIZE
        new_payload[dst:dst + ORIG_POINT_SIZE] = payload[src:src + ORIG_POINT_SIZE]
        new_payload[dst + ORIG_POINT_SIZE] = 0
    _ = zero  # silence linter

    new_header = build_new_header(header_lines)

    if dry_run:
        return 'would_update'

    tmp_path = path + '.tmp_classify'
    with open(tmp_path, 'wb') as out:
        out.write(new_header)
        out.write(bytes(new_payload))
        if trailing:
            out.write(trailing)
    os.replace(tmp_path, path)
    return 'updated'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='data', help='root directory to scan')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    counters = {}
    total = 0
    for dirpath, _, filenames in os.walk(args.root):
        for name in filenames:
            if not name.lower().endswith('.pcd'):
                continue
            path = os.path.join(dirpath, name)
            total += 1
            try:
                status = process_file(path, dry_run=args.dry_run)
            except Exception as e:
                status = f'error:{type(e).__name__}:{e}'
            counters[status] = counters.get(status, 0) + 1
            if status.startswith('error') or status.startswith('skip_unexpected') \
                    or status.startswith('skip_body_short'):
                print(f'[{status}] {path}')

    print('---')
    print(f'total pcd files: {total}')
    for k, v in sorted(counters.items()):
        print(f'  {k}: {v}')


if __name__ == '__main__':
    sys.exit(main())
