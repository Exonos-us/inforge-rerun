const { existsSync } = require('node:fs')
const path = require('node:path')

// `@rerun/cloud-mobile/*` is Rerun Cloud's side when the private cloud/ folder is in the checkout, and
// the open source side in src/cloud-oss/ otherwise: the same fallback as the `paths` of tsconfig.json.
const CLOUD_SOURCE = path.resolve(__dirname, '../../cloud/apps/mobile/src')
const CLOUD_MOBILE = existsSync(CLOUD_SOURCE) ? CLOUD_SOURCE : path.resolve(__dirname, 'src/cloud-oss')

module.exports = {
    "preset": "jest-expo",
    "resolver": "./jest.resolver.js",
    "setupFiles": [
        "react-native-gesture-handler/jestSetup.js",
        "./jest.setup.js"
    ],
    "transformIgnorePatterns": [
        "node_modules/(?!(.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|native-base|react-native-svg|marked|remend))"
    ],
    "moduleNameMapper": {
        "^@rerun/cloud-mobile/(.*)$": `${CLOUD_MOBILE}/$1`,
        "^remend$": "<rootDir>/node_modules/remend/dist/index.js"
    }
}
