// The iOS launch screen drawn as the Home's first frame: the "Coworkers" title and the skeleton
// rows, at the very place the app draws them (HomeBoot, then the Home itself), in light and dark.
// The app then fills the rows in place instead of cutting from a logo.
//
// It replaces what expo-splash-screen puts in SplashScreen.storyboard, so it must be listed before
// that plugin in app.json: mods run last-registered first, and this one has to see its output.
//
// A launch screen takes no runtime attributes, so no corner radius on a view: every rounded shape
// is an image, drawn here at prebuild in both appearances, the bars stretching between round caps.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { Buffer } = require('buffer')
const { withDangerousMod, withMod } = require('expo/config-plugins')

// Mirrors src/theme/tokens.ts, src/components/home/HomeSkeleton.tsx, the Home's header and the sidebar
// of src/components/layout/split.ts: Node cannot import them. launch-layout.test.ts keeps both sides equal.
const LAUNCH_LAYOUT = {
    background: { light: '#f8f8f8', dark: '#0a0a0a' },
    muted: { light: '#efefef', dark: '#232323' },
    title: { image: 'LaunchTitle', left: 24, top: 68, width: 140, height: 36 },
    listTop: 116,
    rows: 6,
    rowHeight: 68,
    avatar: { left: 24, top: 14, size: 36, radius: 12 },
    column: { left: 76, right: 24 },
    name: { top: 16, height: 14 },
    status: { top: 40, height: 12 },
    barRadius: 8,
    barWidths: index => ({ name: 40 + ((index * 17) % 30), status: 60 + ((index * 23) % 30) }),
    // A regular-width screen (an iPad, an unfolded iPhone Duo) opens on the Home as a sidebar.
    sidebar: { share: 0.32, min: 260, max: 340 },
}

const TITLE_IMAGES = [
    { file: 'coworkers-title@2x.png', scale: 2 },
    { file: 'coworkers-title@3x.png', scale: 3 },
    { file: 'coworkers-title-dark@2x.png', scale: 2, dark: true },
    { file: 'coworkers-title-dark@3x.png', scale: 3, dark: true },
]
// SplashScreenBackground is written by expo-splash-screen, from its light and dark backgroundColor.
const BACKGROUND_COLOR = 'SplashScreenBackground'
const DARK = [{ appearance: 'luminosity', value: 'dark' }]
const SCALES = [2, 3]

// A corner never rounds past half the side, as React Native clamps it.
function cornerOf(height) {
    return Math.min(LAUNCH_LAYOUT.barRadius, height / 2)
}

// The rounded shapes of the skeleton, by asset name. A bar is drawn at its height with a 1 pt middle
// that stretches to any width.
const SHAPES = {
    LaunchAvatar: { width: LAUNCH_LAYOUT.avatar.size, height: LAUNCH_LAYOUT.avatar.size, radius: LAUNCH_LAYOUT.avatar.radius, stretches: false },
    LaunchNameBar: { width: cornerOf(LAUNCH_LAYOUT.name.height) * 2 + 1, height: LAUNCH_LAYOUT.name.height, radius: cornerOf(LAUNCH_LAYOUT.name.height), stretches: true },
    LaunchStatusBar: { width: cornerOf(LAUNCH_LAYOUT.status.height) * 2 + 1, height: LAUNCH_LAYOUT.status.height, radius: cornerOf(LAUNCH_LAYOUT.status.height), stretches: true },
}

function frame(width = 10, height = 10) {
    return [{ $: { key: 'frame', x: '0.0', y: '0.0', width: String(width), height: String(height) } }]
}

function constraint(id, first, second, { constant = 0, multiplier, priority } = {}) {
    const [firstItem, firstAttribute] = first
    const attributes = { firstItem, firstAttribute }
    if (second) Object.assign(attributes, { secondItem: second[0], secondAttribute: second[1] })
    if (multiplier !== undefined) attributes.multiplier = String(multiplier)
    if (constant) attributes.constant = String(constant)
    if (priority !== undefined) attributes.priority = String(priority)
    attributes.id = id
    return { $: attributes }
}

function size(id, attribute, constant, relation) {
    return { $: { firstAttribute: attribute, ...(relation ? { relation } : {}), constant: String(constant), id } }
}

// Constraints installed on one width class only: the rest of the storyboard holds for both.
function widthClassVariations({ compactOnly, regularOnly }) {
    const mask = (include, exclude) => [{ $: { key: 'constraints' }, ...(include.length ? { include: include.map(reference => ({ $: { reference } })) } : {}), ...(exclude.length ? { exclude: exclude.map(reference => ({ $: { reference } })) } : {}) }]
    return [
        { $: { key: 'default' }, mask: mask([], regularOnly) },
        { $: { key: 'widthClass=regular' }, mask: mask(regularOnly, compactOnly) },
    ]
}

function imageView(id, image, { width, height, constraints = [] }) {
    return {
        $: { userInteractionEnabled: 'NO', contentMode: 'scaleToFill', image, translatesAutoresizingMaskIntoConstraints: 'NO', id, userLabel: id },
        rect: frame(width, height),
        constraints: [{ constraint: constraints }],
    }
}

function launchScreen(xml) {
    const layout = LAUNCH_LAYOUT
    const container = xml.document.scenes[0].scene[0].objects[0].viewController[0].view[0]
    const containerId = container.$.id
    const safeArea = container.viewLayoutGuide.find(guide => guide.$.key === 'safeArea').$.id

    // An invisible view as wide as the sidebar the app draws on a regular-width screen.
    const sidebar = 'RR-sidebar'
    const sidebarView = {
        $: { contentMode: 'scaleToFill', translatesAutoresizingMaskIntoConstraints: 'NO', id: sidebar, userLabel: sidebar },
        rect: frame(layout.sidebar.min, 1),
        color: [{ $: { key: 'backgroundColor', white: '0.0', alpha: '0.0', colorSpace: 'custom', customColorSpace: 'genericGamma22GrayColorSpace' } }],
        constraints: [{ constraint: [size(`${sidebar}-h`, 'height', 1), size(`${sidebar}-min`, 'width', layout.sidebar.min, 'greaterThanOrEqual'), size(`${sidebar}-max`, 'width', layout.sidebar.max, 'lessThanOrEqual')] }],
    }
    const compactOnly = []
    const regularOnly = []

    const images = [imageView('RR-title', layout.title.image, { ...layout.title, constraints: [size('RR-title-w', 'width', layout.title.width), size('RR-title-h', 'height', layout.title.height)] })]
    const columns = []
    const constraints = [
        constraint('RR-title-left', ['RR-title', 'leading'], [containerId, 'leading'], { constant: layout.title.left }),
        constraint('RR-title-top', ['RR-title', 'top'], [safeArea, 'top'], { constant: layout.title.top }),
        constraint(`${sidebar}-left`, [sidebar, 'leading'], [containerId, 'leading']),
        constraint(`${sidebar}-top`, [sidebar, 'top'], [containerId, 'top']),
        constraint(`${sidebar}-share`, [sidebar, 'width'], [containerId, 'width'], { multiplier: layout.sidebar.share, priority: 750 }),
    ]

    for (let index = 0; index < layout.rows; index++) {
        const rowTop = layout.listTop + index * layout.rowHeight
        const avatar = `RR-avatar-${index}`
        const column = `RR-column-${index}`
        const name = `RR-name-${index}`
        const status = `RR-status-${index}`
        const widths = layout.barWidths(index)

        images.push(imageView(avatar, 'LaunchAvatar', { width: layout.avatar.size, height: layout.avatar.size, constraints: [size(`${avatar}-w`, 'width', layout.avatar.size), size(`${avatar}-h`, 'height', layout.avatar.size)] }))
        constraints.push(constraint(`${avatar}-left`, [avatar, 'leading'], [containerId, 'leading'], { constant: layout.avatar.left }), constraint(`${avatar}-top`, [avatar, 'top'], [safeArea, 'top'], { constant: rowTop + layout.avatar.top }))

        // The text column the bars' widths are shares of, as in HomeSkeleton.
        columns.push({
            $: { contentMode: 'scaleToFill', translatesAutoresizingMaskIntoConstraints: 'NO', id: column, userLabel: column },
            rect: frame(),
            subviews: [
                {
                    imageView: [
                        imageView(name, 'LaunchNameBar', { height: layout.name.height, constraints: [size(`${name}-h`, 'height', layout.name.height)] }),
                        imageView(status, 'LaunchStatusBar', { height: layout.status.height, constraints: [size(`${status}-h`, 'height', layout.status.height)] }),
                    ],
                },
            ],
            color: [{ $: { key: 'backgroundColor', white: '0.0', alpha: '0.0', colorSpace: 'custom', customColorSpace: 'genericGamma22GrayColorSpace' } }],
            constraints: [
                {
                    constraint: [
                        size(`${column}-h`, 'height', layout.rowHeight),
                        constraint(`${name}-left`, [name, 'leading'], [column, 'leading']),
                        constraint(`${name}-top`, [name, 'top'], [column, 'top'], { constant: layout.name.top }),
                        constraint(`${name}-w`, [name, 'width'], [column, 'width'], { multiplier: widths.name / 100 }),
                        constraint(`${status}-left`, [status, 'leading'], [column, 'leading']),
                        constraint(`${status}-top`, [status, 'top'], [column, 'top'], { constant: layout.status.top }),
                        constraint(`${status}-w`, [status, 'width'], [column, 'width'], { multiplier: widths.status / 100 }),
                    ],
                },
            ],
        })
        constraints.push(
            constraint(`${column}-left`, [column, 'leading'], [containerId, 'leading'], { constant: layout.column.left }),
            constraint(`${column}-right`, [containerId, 'trailing'], [column, 'trailing'], { constant: layout.column.right }),
            constraint(`${column}-right-split`, [sidebar, 'trailing'], [column, 'trailing'], { constant: layout.column.right }),
            constraint(`${column}-top`, [column, 'top'], [safeArea, 'top'], { constant: rowTop })
        )
        compactOnly.push(`${column}-right`)
        regularOnly.push(`${column}-right-split`)
    }

    container.subviews = [{ imageView: images, view: [sidebarView, ...columns] }]
    container.constraints = [{ constraint: constraints }]
    container.variation = widthClassVariations({ compactOnly, regularOnly })
    container.color = [{ $: { key: 'backgroundColor', name: BACKGROUND_COLOR } }]

    const resources = xml.document.resources[0]
    resources.image = [{ $: { name: layout.title.image, width: String(layout.title.width), height: String(layout.title.height) } }, ...Object.entries(SHAPES).map(([name, shape]) => ({ $: { name, width: String(shape.width), height: String(shape.height) } }))]
    delete resources.systemColor
    resources.namedColor = [namedColor(BACKGROUND_COLOR, LAUNCH_LAYOUT.background.light)]
    return xml
}

function channels(hex) {
    return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16))
}

// The storyboard's own copy of a catalog colour, light only: the catalog's wins at run time.
function namedColor(name, hex) {
    const [red, green, blue] = channels(hex).map(value => (value / 255).toFixed(3))
    return { $: { name }, color: [{ $: { red, green, blue, alpha: '1.000', colorSpace: 'custom', customColorSpace: 'sRGB' } }] }
}

// A filled rounded rectangle as a PNG, its edge antialiased by sampling each pixel 4 × 4 times.
function roundedRectPng({ width, height, radius }, scale, hex) {
    const pixels = { width: Math.round(width * scale), height: Math.round(height * scale) }
    const r = radius * scale
    const [red, green, blue] = channels(hex)
    const inside = (x, y) => {
        const dx = Math.max(r - x, 0, x - (pixels.width - r))
        const dy = Math.max(r - y, 0, y - (pixels.height - r))
        return dx * dx + dy * dy <= r * r
    }
    const raw = Buffer.alloc((pixels.width * 4 + 1) * pixels.height)
    for (let y = 0; y < pixels.height; y++) {
        const row = y * (pixels.width * 4 + 1)
        for (let x = 0; x < pixels.width; x++) {
            let covered = 0
            for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) covered++
            raw.set([red, green, blue, Math.round((covered / 16) * 255)], row + 1 + x * 4)
        }
    }
    const chunk = (type, data) => {
        const length = Buffer.alloc(4)
        length.writeUInt32BE(data.length)
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
        const crc = Buffer.alloc(4)
        crc.writeUInt32BE(zlib.crc32(body))
        return Buffer.concat([length, body, crc])
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(pixels.width, 0)
    header.writeUInt32BE(pixels.height, 4)
    header.set([8, 6, 0, 0, 0], 8)
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function writeImageset(catalog, name, images) {
    const imageset = path.join(catalog, `${name}.imageset`)
    fs.rmSync(imageset, { recursive: true, force: true })
    fs.mkdirSync(imageset, { recursive: true })
    const entries = images.map(({ file, data, scale, dark, resizing }) => {
        fs.writeFileSync(path.join(imageset, file), data)
        return { filename: file, idiom: 'universal', scale: `${scale}x`, ...(dark ? { appearances: DARK } : {}), ...(resizing ? { resizing } : {}) }
    })
    fs.writeFileSync(path.join(imageset, 'Contents.json'), JSON.stringify({ images: entries, info: { version: 1, author: 'expo' } }, null, 2))
}

// A title image re-rendered at another size would sit stretched in the frame the storyboard gives it.
function titleImage(projectRoot, file, scale) {
    const data = fs.readFileSync(path.join(projectRoot, 'assets/launch', file))
    const pixels = { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
    const expected = { width: LAUNCH_LAYOUT.title.width * scale, height: LAUNCH_LAYOUT.title.height * scale }
    if (pixels.width !== expected.width || pixels.height !== expected.height) {
        throw new Error(`assets/launch/${file} is ${pixels.width} x ${pixels.height} px, the launch screen expects ${expected.width} x ${expected.height}: update LAUNCH_LAYOUT.title`)
    }
    return data
}

function writeAssets(projectRoot, catalog) {
    writeImageset(
        catalog,
        LAUNCH_LAYOUT.title.image,
        TITLE_IMAGES.map(({ file, scale, dark }) => ({ file, scale, dark, data: titleImage(projectRoot, file, scale) }))
    )
    for (const [name, shape] of Object.entries(SHAPES)) {
        const images = []
        for (const dark of [false, true]) {
            for (const scale of SCALES) {
                const cap = shape.radius * scale
                const resizing = shape.stretches ? { mode: '3-part-horizontal', center: { mode: 'stretch', width: scale }, 'cap-insets': { left: cap, right: cap } } : undefined
                images.push({ file: `${name}${dark ? '-dark' : ''}@${scale}x.png`, scale, dark, resizing, data: roundedRectPng(shape, scale, dark ? LAUNCH_LAYOUT.muted.dark : LAUNCH_LAYOUT.muted.light) })
            }
        }
        writeImageset(catalog, name, images)
    }
}

function withHomeLaunchScreen(config) {
    config = withMod(config, {
        platform: 'ios',
        mod: 'splashScreenStoryboard',
        action: config => {
            config.modResults = launchScreen(config.modResults)
            return config
        },
    })
    return withDangerousMod(config, [
        'ios',
        config => {
            const { projectRoot, platformProjectRoot, projectName } = config.modRequest
            writeAssets(projectRoot, path.join(platformProjectRoot, projectName, 'Images.xcassets'))
            return config
        },
    ])
}

module.exports = withHomeLaunchScreen
module.exports.LAUNCH_LAYOUT = LAUNCH_LAYOUT
