// Hand-written copy for the swap detail page, keyed by the underlying ticker. Robinhood and 1inch
// publish no company or fund descriptions, so each buy target carries its own; a test requires one
// for every target on both chains. Coinbase's Base tokens add a "c" suffix to the ticker.
export type TokenKind = "stock" | "fund";
export type TokenProfile = { kind: TokenKind; description: string };

export const TOKEN_PROFILES: Readonly<Record<string, TokenProfile>> = {
  QQQ: { kind: "fund", description: "Invesco QQQ tracks the Nasdaq-100 index, the 100 largest non-financial companies listed on the Nasdaq." },
  NVDA: { kind: "stock", description: "NVIDIA designs graphics processors and accelerated computing platforms used for gaming, data centers and AI." },
  SPCX: { kind: "stock", description: "Space Exploration Technologies (SpaceX) builds and launches rockets and spacecraft and operates the Starlink satellite internet network." },
  TSLA: { kind: "stock", description: "Tesla makes electric vehicles, battery energy storage and solar products, and develops driver-assistance software." },
  META: { kind: "stock", description: "Meta Platforms runs Facebook, Instagram, WhatsApp and Messenger and builds virtual and augmented reality devices." },
  USO: { kind: "fund", description: "United States Oil Fund tracks daily changes in the price of West Texas Intermediate crude oil through oil futures contracts." },
  MU: { kind: "stock", description: "Micron Technology makes DRAM and NAND memory and storage chips for computers, phones, data centers and cars." },
  GOOGL: { kind: "stock", description: "Alphabet is the parent company of Google, including Search, YouTube, Android and Google Cloud. These are Class A voting shares." },
  GLD: { kind: "fund", description: "SPDR Gold Trust holds physical gold bullion and aims to track the price of gold." },
  AAPL: { kind: "stock", description: "Apple designs the iPhone, Mac, iPad and Apple Watch and runs services such as the App Store, iCloud and Apple Music." },
  SNDK: { kind: "stock", description: "Sandisk makes flash memory and storage products, from memory cards and SSDs to data center storage." },
  CRWV: { kind: "stock", description: "CoreWeave operates a cloud platform that rents GPU computing capacity for training and running AI models." },
  SGOV: { kind: "fund", description: "iShares 0-3 Month Treasury Bond ETF holds U.S. Treasury bills that mature within three months." },
  AMZN: { kind: "stock", description: "Amazon runs an online retail marketplace, Amazon Web Services cloud computing, Prime Video and advertising." },
  BE: { kind: "stock", description: "Bloom Energy makes solid-oxide fuel cell systems that generate electricity on site for businesses and data centers." },
  AMAT: { kind: "stock", description: "Applied Materials supplies the equipment and services chipmakers use to manufacture semiconductors and displays." },
  IBM: { kind: "stock", description: "IBM provides hybrid cloud software, consulting and infrastructure, including mainframes and AI products." },
  MSFT: { kind: "stock", description: "Microsoft makes Windows and Office, runs the Azure cloud platform and owns LinkedIn, GitHub and Xbox." },
  SLV: { kind: "fund", description: "iShares Silver Trust holds physical silver and aims to track the price of silver." },
  LLY: { kind: "stock", description: "Eli Lilly develops and sells medicines, including treatments for diabetes, obesity, cancer and immune conditions." },
  RDDT: { kind: "stock", description: "Reddit runs an online platform of user-created communities where people post, discuss and vote on content." },
  MRVL: { kind: "stock", description: "Marvell Technology designs chips for data centers, networking, storage and custom AI infrastructure." },
  TTWO: { kind: "stock", description: "Take-Two Interactive publishes video games through labels including Rockstar Games, 2K and Zynga." },
  INTC: { kind: "stock", description: "Intel designs and manufactures processors for PCs and data centers and offers contract chip manufacturing." },
  AVGO: { kind: "stock", description: "Broadcom designs semiconductors for networking, broadband and custom AI chips, and sells infrastructure software." },
  // Base-only buy targets.
  KO: { kind: "stock", description: "The Coca-Cola Company makes and sells soft drinks, juices, water, coffee and tea, with brands including Coca-Cola, Sprite and Fanta." },
  "BRK.B": { kind: "stock", description: "Berkshire Hathaway is a holding company that owns GEICO, BNSF Railway and Berkshire Hathaway Energy and large stakes in public companies. These are Class B shares." },
  MCD: { kind: "stock", description: "McDonald's operates and franchises fast-food restaurants serving burgers, fries and breakfast in more than 100 countries." },
  ANT: { kind: "stock", description: "Anthropic is an AI safety and research company that develops the Claude family of AI models. It is a privately held public benefit corporation." },
  ORCL: { kind: "stock", description: "Oracle sells database software, enterprise applications and Oracle Cloud Infrastructure computing services." },
  HSAI: { kind: "stock", description: "Hesai Group makes lidar sensors used in driver-assistance systems, autonomous vehicles and robotics." },
  BUD: { kind: "stock", description: "Anheuser-Busch InBev is the world's largest brewer, with beer brands including Budweiser, Stella Artois, Corona and Michelob Ultra." },
  NVO: { kind: "stock", description: "Novo Nordisk develops and sells medicines for diabetes and obesity, including Ozempic and Wegovy, and treatments for rare diseases." },
  UL: { kind: "stock", description: "Unilever makes beauty, personal care, home care and food products, with brands such as Dove, Hellmann's and Knorr." },
  PDD: { kind: "stock", description: "PDD Holdings runs the Pinduoduo shopping platform in China and the Temu online marketplace in other countries." },
  SONY: { kind: "stock", description: "Sony Group makes PlayStation consoles, image sensors, cameras and electronics and owns music, film and TV businesses." },
  AMD: { kind: "stock", description: "Advanced Micro Devices designs processors, graphics chips and AI accelerators for PCs, game consoles and data centers." },
  SAP: { kind: "stock", description: "SAP makes enterprise software for finance, supply chains, human resources and other business operations, increasingly delivered from its cloud." },
  MRNA: { kind: "stock", description: "Moderna develops messenger RNA (mRNA) medicines and vaccines, including vaccines against COVID-19 and RSV." },
  INFY: { kind: "stock", description: "Infosys provides IT consulting, software development, outsourcing and digital transformation services to businesses worldwide." },
  LI: { kind: "stock", description: "Li Auto designs, makes and sells battery-electric and extended-range electric SUVs in China." },
  NOK: { kind: "stock", description: "Nokia makes mobile, fixed and IP network equipment and licenses its patent portfolio to device makers." },
  MSTR: { kind: "stock", description: "Strategy, formerly MicroStrategy, holds bitcoin as its primary treasury reserve asset and sells business analytics software." },
  CRCL: { kind: "stock", description: "Circle Internet Group issues the USDC and EURC stablecoins and provides payment and blockchain infrastructure for businesses." },
  PLTR: { kind: "stock", description: "Palantir Technologies builds data integration, analytics and AI software platforms used by governments and companies." },
  HOOD: { kind: "stock", description: "Robinhood Markets runs a trading app for stocks, options and crypto and offers retirement accounts and banking products." },
};

/** The profile behind a Base token, whose Coinbase symbol is the ticker plus "c" (GOOGLc). */
export const baseTokenProfile = (symbol: string): TokenProfile | undefined =>
  symbol.endsWith("c") ? TOKEN_PROFILES[symbol.slice(0, -1)] : undefined;
