#!/usr/bin/env python3
"""Write the raw grayscale frames every counter fixture is encoded from.

Each frame says which frame it is, twice, in two different languages:

  * The BOTTOM half carries a white bar, 5 pixels wide, at x = 5 * n. This is
    the machine-readable half, and the test suite reads nothing else. Position
    survives a browser's YUV-to-RGB conversion exactly, which a brightness code
    would not, and the frame is 5 * frameCount pixels wide so the bars tile it
    with no column belonging to no frame.
  * The TOP half carries the frame number in plain digits, large enough to read
    across a room. Nothing in the suite looks at it. It is there so a person can
    open one of these clips in any player -- or in the demo page, or in the app
    being debugged -- and see immediately which frame is on screen, instead of
    counting bar positions by eye.

The two halves never overlap, so the bar reading cannot be confused by a digit
and the digits cannot be clipped by a bar.

The digits are drawn from the 5x7 bitmap font below rather than by ffmpeg's
drawtext filter, because drawtext needs an ffmpeg built with libfreetype and
plenty are not (including the one on the machine this was written for). A
handful of bytes of font data has no such problem.

Output is headerless 8-bit grayscale, one frame after another, which ffmpeg
reads with:

    -f rawvideo -pix_fmt gray -video_size WxH -framerate R -i FILE

Usage:
    make-counter-frames.py WIDTH HEIGHT FRAME_COUNT OUTPUT
"""

import sys

# A 5x7 bitmap font, digits only -- the only characters a frame number needs.
# Each string is one row, '#' for an ink pixel.
DIGIT_GLYPHS = {
    '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
    '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
    '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
    '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
    '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
    '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
}

GLYPH_WIDTH = 5
GLYPH_HEIGHT = 7
GLYPH_GAP = 1        # columns between digits, in unscaled font pixels

BAR_WIDTH = 5        # pixels per frame slot, matching BARS_ACROSS in the tests
INK = 255
PAPER = 0


def digit_scale(text, width, top_height):
    """The largest whole-pixel scale at which `text` fits the top half.

    Whole pixels only: a fractional scale would put grey edges on the digits,
    and while nothing measures them, a fixture whose only two values are 0 and
    255 is one fewer thing to wonder about when a test fails.
    """
    columns = len(text) * GLYPH_WIDTH + (len(text) - 1) * GLYPH_GAP
    # Leave a two-pixel margin so nothing touches the frame edge or the seam
    # between the halves.
    by_width = (width - 4) // columns
    by_height = (top_height - 4) // GLYPH_HEIGHT
    return max(1, min(by_width, by_height))


def draw_number(frame, width, top_height, number):
    """Draw `number` centred in the top half of `frame` (a bytearray)."""
    text = str(number)
    scale = digit_scale(text, width, top_height)
    columns = len(text) * GLYPH_WIDTH + (len(text) - 1) * GLYPH_GAP
    left = (width - columns * scale) // 2
    top = (top_height - GLYPH_HEIGHT * scale) // 2

    for position, character in enumerate(text):
        glyph = DIGIT_GLYPHS[character]
        origin = left + position * (GLYPH_WIDTH + GLYPH_GAP) * scale
        for row_index, row in enumerate(glyph):
            for column_index, cell in enumerate(row):
                if cell != '#':
                    continue
                for y in range(scale):
                    pixel_row = top + row_index * scale + y
                    if not 0 <= pixel_row < top_height:
                        continue
                    start = pixel_row * width + origin + column_index * scale
                    for x in range(scale):
                        column = origin + column_index * scale + x
                        if 0 <= column < width:
                            frame[start + x] = INK


def draw_bar(frame, width, height, top_height, number):
    """Draw the frame's white bar across the bottom half."""
    first_column = BAR_WIDTH * number
    for y in range(top_height, height):
        row_start = y * width
        for column in range(first_column, min(first_column + BAR_WIDTH, width)):
            frame[row_start + column] = INK


def write_frames(width, height, frame_count, path):
    top_height = height // 2
    with open(path, 'wb') as output:
        for number in range(frame_count):
            frame = bytearray([PAPER]) * (width * height)
            draw_bar(frame, width, height, top_height, number)
            draw_number(frame, width, top_height, number)
            output.write(frame)


def main(argv):
    if len(argv) != 5:
        print(__doc__, file=sys.stderr)
        return 2
    width, height, frame_count = (int(value) for value in argv[1:4])
    if BAR_WIDTH * frame_count > width:
        print(f'error: {frame_count} bars of {BAR_WIDTH} pixels do not fit in '
              f'{width} pixels; widen the frame or reduce the count',
              file=sys.stderr)
        return 1
    write_frames(width, height, frame_count, argv[4])
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
