"""Capture the real OpenCode TUI through a PTY; never synthesize a model response."""
import json
import os
from pathlib import Path
import re
import sys
import time

import pexpect
import pyte
from wcwidth import wcwidth


def terminal_lines(screen):
    # pyte.display crashes on an orphan wide-glyph continuation cell during a redraw.
    # Preserve the actual buffer cells, rendering a cleared continuation as blank.
    rows = []
    for y in range(screen.lines):
        line, wide = [], False
        for x in range(screen.columns):
            if wide:
                wide = False
                continue
            value = screen.buffer[y][x].data
            line.append(value or ' ')
            wide = bool(value) and wcwidth(value[0]) == 2
        rows.append(''.join(line))
    return rows

directory, server, session, evidence = sys.argv[1:]
root = Path(evidence)
screen = pyte.HistoryScreen(160, 100, history=3000)
stream = pyte.Stream(screen)
child = pexpect.spawn('opencode', ['--server', server, '--session', session],
                      cwd=directory, env={**os.environ, 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor'},
                      dimensions=(100, 160), encoding='utf-8', codec_errors='replace', timeout=1)
seen = set()
started = time.monotonic()
navigation = 0
next_navigation = 0
with (root / 'terminal.ansi').open('w') as raw:
    try:
        while time.monotonic() - started < 240:
            # Read the existing report using ordinary navigation; no message is submitted.
            if (root / 'inspect-report').exists() and time.monotonic() >= next_navigation and navigation < 3:
                child.send(['\x1b[F', '\x1b[5~', '\x1b[F'][navigation])
                navigation += 1
                next_navigation = time.monotonic() + 1
            if navigation == 3 and time.monotonic() >= next_navigation:
                (root / 'report-inspected').write_text('End, PageUp, End; no prompt submitted')
            try:
                data = child.read_nonblocking(262144, timeout=0.25)
                raw.write(data)
                raw.flush()
                stream.feed(data)
                # Respond to terminal capability/cursor queries, not application prompts.
                if '\x1b[6n' in data:
                    child.send('\x1b[1;1R')
                if '\x1b[c' in data or '\x1b[0c' in data:
                    child.send('\x1b[?1;2c')
                if '\x1b[>c' in data:
                    child.send('\x1b[>0;136;0c')
                if '\x1b[?u' in data:
                    child.send('\x1b[?0u')
                display = '\n'.join(terminal_lines(screen))
                (root / 'screen-latest.txt').write_text(display)
                if len(display.strip()) > 100:
                    (root / 'tui-ready.json').write_text(json.dumps({'pid': child.pid}))
                five_fields = (all(label in display for label in ['いま:', '確認済み:', '未解決:', '推定費用:', '持ち帰り:'])
                               and re.search(r'持ち帰り:.*(成果物はまだありません|（未受理）|記録 [a-f0-9-]{36})', display)
                               and re.search(r'推定費用:.*(0ドルではありません）|請求額ではありません）)', display))
                for stage, pattern in [('departure', r'出撃'), ('live', r'🐾 (executing|inspecting|thinking|correcting)'),
                                        ('executing', r'🐾 executing'),
                                        ('overview-live', r'🐾 (executing|inspecting|thinking|correcting)' if five_fields else r'(?!)'),
                                        ('overview-returned', r'🐾 returned' if five_fields else r'(?!)'),
                                        ('return', r'帰還報告'), ('mission', r'MISSION'),
                                       ('cost', r'COST / PACK'), ('career', r'PACK RECORD')]:
                    if stage not in seen and re.search(pattern, display):
                        seen.add(stage)
                        (root / ('screen-' + stage + '.txt')).write_text(display)
                if (root / 'capture-stop').exists():
                    break
            except pexpect.TIMEOUT:
                if (root / 'capture-stop').exists():
                    break
            except pexpect.EOF:
                break
    finally:
        (root / 'capture.json').write_text(json.dumps({'stages': sorted(seen), 'elapsed_s': time.monotonic() - started,
                                                      'renderer': 'native OpenCode TUI, 160x100 PTY, pyte 0.8.2'}))
        child.terminate(force=True)
