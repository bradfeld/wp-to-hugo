export interface FixturePost {
  id: number;
  date: string;
  slug: string;
  status: string;
  author?: number;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  categories: number[];
  tags: number[];
  featured_media: number;
  link: string;
}

export interface FixtureTerm {
  id: number;
  name: string;
  slug: string;
  count: number;
}

export function makeFixturePost(overrides: Partial<FixturePost> = {}): FixturePost {
  return {
    id: 42,
    date: "2024-03-15T10:00:00",
    slug: "hello-world",
    status: "publish",
    author: 1,
    title: { rendered: "Hello World" },
    content: { rendered: "<p>Hello world.</p>" },
    excerpt: { rendered: "<p>Hello world excerpt.</p>" },
    categories: [10],
    tags: [20],
    featured_media: 0,
    link: "https://example.com/archives/2024/03/hello-world/",
    ...overrides,
  };
}

export function makeFixtureCategory(overrides: Partial<FixtureTerm> = {}): FixtureTerm {
  return {
    id: 10,
    name: "Essays",
    slug: "essays",
    count: 1,
    ...overrides,
  };
}

export function makeFixtureTag(overrides: Partial<FixtureTerm> = {}): FixtureTerm {
  return {
    id: 20,
    name: "Writing",
    slug: "writing",
    count: 1,
    ...overrides,
  };
}
