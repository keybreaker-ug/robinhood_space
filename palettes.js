window.PALETTES = {
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

window.ALLOCATION_PALETTE = {
    name: 'Okabe-Ito Dark Safe',
    etfBase: '#0072B2',
    sectorColors: ['#E69F00', '#009E73', '#CC79A7', '#D55E00', '#56B4E9', '#F0E442', '#9467BD', '#66A61E', '#8C564B', '#999999'],
    otherColor: '#7A7A7A',
    separatorStroke: 'rgba(148, 163, 184, 0.45)',
};

window.sectorPalette = function sectorPalette() {
    return [...window.ALLOCATION_PALETTE.sectorColors];
};

window.getSectorColorForIndex = function getSectorColorForIndex(index) {
    const colors = window.ALLOCATION_PALETTE.sectorColors;
    return colors[index % colors.length];
};

window.getEtfShadeColor = function getEtfShadeColor(index, total) {
    const blueFamily = ['#005A8D', '#0072B2', '#1C8CD2', '#38A8E8', '#67C0F2', '#94D6FA', '#2E73A6', '#4B9BCF'];
    return blueFamily[index % blueFamily.length];
};

window.etfHueRamp = function etfHueRamp(baseColor, count) {
    const safeCount = Math.max(1, count);
    const hex = (baseColor || '#0072B2').replace('#', '');
    const normalized = hex.length === 3
        ? hex.split('').map((char) => char + char).join('')
        : hex.padEnd(6, '0').slice(0, 6);
    const red = parseInt(normalized.slice(0, 2), 16) / 255;
    const green = parseInt(normalized.slice(2, 4), 16) / 255;
    const blue = parseInt(normalized.slice(4, 6), 16) / 255;

    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;

    let hue = 208;
    if (delta !== 0) {
        if (max === red) hue = ((green - blue) / delta) % 6;
        else if (max === green) hue = (blue - red) / delta + 2;
        else hue = (red - green) / delta + 4;
        hue = Math.round(hue * 60);
        if (hue < 0) hue += 360;
    }

    const startL = 34;
    const endL = 66;
    const saturation = 74;
    return Array.from({ length: safeCount }, (_, index) => {
        const ratio = safeCount === 1 ? 0.5 : index / (safeCount - 1);
        const lightness = Math.round(startL + (endL - startL) * ratio);
        return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    });
};

window.getColorForIndex = function getColorForIndex(paletteName, index) {
    const palette = window.PALETTES[paletteName] || window.PALETTES.vibrant;
    const colors = palette.colors;
    return colors[index % colors.length];
};
