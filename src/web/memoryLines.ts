interface MemoryLine {
    // The place of the line in the file, for removing it.
    index: number;
    text: string;
}

interface MemorySection {
    title: string | undefined;
    lines: MemoryLine[];
}

const HEADING_PATTERN = /^#{1,6}\s+(.*)$/;
const LIST_MARK_PATTERN = /^\s*(?:[-*+]|\d+\.)\s+/;

// The memory is free text that the bot writes. Each line is one thing it learned, and a heading starts a new group.
function memorySections(text: string): MemorySection[] {
    const fileLines = text.split('\n');
    const sections = fileLines.reduce<MemorySection[]>((found, line, index) => {
        const trimmedLine = line.trim();
        const heading = HEADING_PATTERN.exec(trimmedLine);

        if (heading !== null) {
            found.push({ title: heading[1], lines: [] });
        } else if (trimmedLine !== '') {
            const section = found.at(-1);
            const memoryLine = { index, text: line.replace(LIST_MARK_PATTERN, '') };

            if (section === undefined) {
                found.push({ title: undefined, lines: [memoryLine] });
            } else {
                section.lines.push(memoryLine);
            }
        }

        return found;
    }, []);

    return sections.filter(section => section.lines.length > 0);
}

function withoutMemoryLine(text: string, index: number): string {
    const fileLines = text.split('\n');
    const keptLines = fileLines.filter((_line, lineIndex) => lineIndex !== index);

    return keptLines.join('\n');
}

export { memorySections, withoutMemoryLine };
export type { MemoryLine, MemorySection };
