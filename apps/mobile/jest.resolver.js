const path = require('node:path')

const presetResolver = require(require('jest-expo/jest-preset').resolver)

// The Reanimated modules that run as their web version in Jest, copied from
// react-native-reanimated/jest/resolver.js. That resolver can't be used as it is: it matches packages by
// a substring of the path, and under pnpm every package that peers on react-native-worklets matches
// (expo-modules-core, Reanimated itself), which strips their native modules.
const REANIMATED_WEB_ONLY = ['initializers', 'mutables', 'mappers', 'ConfigHelper', 'UpdateLayoutAnimations', 'useAnimatedRef', 'useAnimatedStyle', 'WorkletEventHandler', 'JSPropsUpdater', 'updateProps', 'util', 'css/component/AnimatedComponent']

function withoutNativeExtensions(options) {
    return { ...options, extensions: options.extensions?.filter(extension => !extension.includes('native')) }
}

function isReanimatedWebOnly(request) {
    const basename = request.split('/').pop()
    return request.startsWith('.') && REANIMATED_WEB_ONLY.some(entry => (entry.includes('/') ? request.endsWith(entry) : basename === entry))
}

module.exports = (request, options) => {
    const packages = options.basedir.split(path.sep)
    const worklets = packages.includes('react-native-worklets') || request === 'react-native-worklets' || request.startsWith('react-native-worklets/')
    const reanimatedWebOnly = packages.includes('react-native-reanimated') && isReanimatedWebOnly(request)
    return presetResolver(request, worklets || reanimatedWebOnly ? withoutNativeExtensions(options) : options)
}
