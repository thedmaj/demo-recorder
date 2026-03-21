import { Config } from '@remotion/cli/config';

// Enable webpack bundle caching — saves ~15s per render after the first run.
// The cache is stored in node_modules/.cache/remotion.
Config.setCachingEnabled(true);

// Use all CPU cores for parallel frame rendering on Linux CI/CD.
Config.setChromiumMultiProcessOnLinux(true);

// Reduce render log verbosity — only show warnings and errors.
// Verbose frame-by-frame logs are noisy in pipeline output.
Config.setLogLevel('warn');
