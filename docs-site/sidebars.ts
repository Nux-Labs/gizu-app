import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'category',
      label: 'Get started',
      collapsible: false,
      items: ['intro', 'getting-started', 'how-it-works'],
    },
    {
      type: 'category',
      label: 'Using Gizu',
      collapsible: false,
      items: ['passkey-wallet', 'adding-funds', 'investing', 'portfolio'],
    },
    {
      type: 'category',
      label: 'Privacy',
      collapsible: false,
      items: ['privacy'],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsible: false,
      items: ['supported-networks', 'faq'],
    },
  ],
};

export default sidebars;
