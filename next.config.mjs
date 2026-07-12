/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    // Weather pages moved under /weather/* when the crypto section was added.
    // Temporary (307) so they can be repointed if the layout changes again.
    return [
      { source: "/advantage", destination: "/weather/advantage", permanent: false },
      { source: "/automation", destination: "/weather/automation", permanent: false },
      { source: "/stats", destination: "/weather/stats", permanent: false },
      { source: "/history", destination: "/weather/history", permanent: false },
    ];
  },
};

export default nextConfig;
