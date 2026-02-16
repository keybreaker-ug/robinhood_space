export type PaletteName = 'vibrant' | 'muted' | 'colorblind';

export interface Palette {
    label: string;
    colors: string[];
}

export interface AllocationPalette {
    name: string;
    etfBase: string;
    sectorColors: string[];
    otherColor: string;
    separatorStroke: string;
}

export const PALETTES: Record<PaletteName, Palette> = {
    vibrant: {
        label: 'Vibrant',
        colors: ['#22D3EE', '#34D399', '#38BDF8', '#A3E635', '#14B8A6', '#2DD4BF', '#818CF8', '#F59E0B', '#F97316', '#06B6D4']
    },
    muted: {
        label: 'Muted',
        colors: ['#67E8F9', '#6EE7B7', '#7DD3FC', '#BEF264', '#5EEAD4', '#93C5FD', '#A7F3D0', '#FDE68A', '#FDBA74', '#99F6E4']
    },
    colorblind: {
        label: 'Colorblind Friendly',
        colors: ['#0072B2', '#009E73', '#56B4E9', '#CC79A7', '#F0E442', '#D55E00', '#332288', '#88CCEE', '#44AA99', '#117733']
    }
};

export function getColorForIndex(palette: PaletteName, index: number): string {
    const selectedPalette = PALETTES[palette] || PALETTES.vibrant;
    return selectedPalette.colors[index % selectedPalette.colors.length];
}

export const ALLOCATION_PALETTE: AllocationPalette = {
    name: 'Okabe-Ito Dark Safe',
    etfBase: '#0072B2',
    sectorColors: ['#E69F00', '#009E73', '#CC79A7', '#D55E00', '#56B4E9', '#F0E442', '#9467BD', '#66A61E', '#8C564B', '#999999'],
    otherColor: '#7A7A7A',
    separatorStroke: 'rgba(148, 163, 184, 0.45)'
};

export function getSectorColorForIndex(index: number): string {
    return ALLOCATION_PALETTE.sectorColors[index % ALLOCATION_PALETTE.sectorColors.length];
}

export function sectorPalette(): string[] {
    return [...ALLOCATION_PALETTE.sectorColors];
}

export function getEtfShadeColor(index: number, total: number): string {
    const blueFamily = ['#005A8D', '#0072B2', '#1C8CD2', '#38A8E8', '#67C0F2', '#94D6FA', '#2E73A6', '#4B9BCF'];
    return blueFamily[index % blueFamily.length];
}

function hexToHue(hexColor: string): number {
    const hex = (hexColor || '#0072B2').replace('#', '');
    const normalized = hex.length === 3
        ? hex.split('').map((char) => char + char).join('')
        : hex.padEnd(6, '0').slice(0, 6);

    const red = parseInt(normalized.slice(0, 2), 16) / 255;
    const green = parseInt(normalized.slice(2, 4), 16) / 255;
    const blue = parseInt(normalized.slice(4, 6), 16) / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;

    if (delta === 0) {
        return 208;
    }

    let hue = 0;
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;

    hue = Math.round(hue * 60);
    return hue < 0 ? hue + 360 : hue;
}

export function etfHueRamp(baseColor: string, count: number): string[] {
    const safeCount = Math.max(1, count);
    const hue = hexToHue(baseColor);
    const startL = 34;
    const endL = 66;
    const saturation = 74;

    return Array.from({ length: safeCount }, (_, index) => {
        const ratio = safeCount === 1 ? 0.5 : index / (safeCount - 1);
        const lightness = Math.round(startL + (endL - startL) * ratio);
        return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    });
}
