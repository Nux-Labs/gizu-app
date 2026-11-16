import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const APP_URL = 'https://app.gizu.io';
const SITE_URL = 'https://gizu.io';

const config: Config = {
  title: 'Gizu Docs',
  tagline: 'Onchain investing, off the record.',
  favicon: 'img/logo.svg',

  // TODO: set to the final docs domain before the first deploy.
  url: 'https://docs.gizu.io',
  baseUrl: '/',

  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          // the docs are the whole site, so they live at the root
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'Gizu',
      logo: {
        alt: 'Gizu',
        src: 'img/logo.svg',
        href: SITE_URL,
        target: '_self',
      },
      items: [
        {type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs'},
        {href: APP_URL, label: 'Get early access', position: 'right', className: 'navbar-cta'},
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Gizu',
          items: [
            {label: 'Website', href: SITE_URL},
            {label: 'Get early access', href: APP_URL},
          ],
        },
        {
          title: 'Docs',
          items: [
            {label: 'How Gizu works', to: '/how-it-works'},
            {label: 'Privacy', to: '/privacy'},
            {label: 'FAQ', to: '/faq'},
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} Gizu`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
