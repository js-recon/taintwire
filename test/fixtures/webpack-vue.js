(window.webpackJsonp = window.webpackJsonp || []).push([
  [42, 12, 17, 35, 36, 40, 41, 48, 51],
  {
    468: function (e, t, n) {
      var content = n(476);
      (content.__esModule && (content = content.default),
        "string" == typeof content && (content = [[e.i, content, ""]]),
        content.locals && (e.exports = content.locals));
      (0, n(58).default)("13e97cac", content, !0, { sourceMap: !1 });
    },
    469: function (e, t, n) {
      "use strict";
      n.r(t);
      (n(59), n(89));
      var r = n(36),
        o = {
          props: {
            images: { type: Array, required: !0 },
            orientation: { type: String, default: "landscape" },
          },
          data: function () {
            return { activeIndex: 0 };
          },
          mounted: function () {
            1 !== this.images.length && this.startSlideshow();
          },
          methods: {
            startSlideshow: function () {
              var e = this;
              setInterval(function () {
                var t = (e.activeIndex + 1) % e.images.length;
                (e.fadeTransition(e.activeIndex, t), (e.activeIndex = t));
              }, 2500);
            },
            fadeTransition: function (e, t) {
              var n = this.$el.children[e],
                o = this.$el.children[t];
              (r.c.to(n, { opacity: 0, duration: 0.5 }),
                r.c.fromTo(o, { opacity: 0 }, { opacity: 1, duration: 0.4 }));
            },
          },
        },
        l = (n(475), n(29)),
        component = Object(l.a)(
          o,
          function () {
            var e = this,
              t = e._self._c;
            return t(
              "div",
              {
                staticClass: "image-collection flex relative justify-center",
                class: [
                  {
                    "h-64 w-full": "landscape" === e.orientation,
                    "h-96 w-full": "portrait" === e.orientation,
                  },
                ],
              },
              e._l(e.images, function (image, n) {
                return t(
                  "div",
                  {
                    key: "".concat(image, "-").concat(n),
                    staticClass: "image-wrapper h-full w-full",
                    class: { "is-active": n === e.activeIndex },
                  },
                  [
                    t("img", {
                      staticClass: "w-full h-full object-cover",
                      attrs: { src: image, alt: "Image ".concat(n) },
                    }),
                  ],
                );
              }),
              0,
            );
          },
          [],
          !1,
          null,
          null,
          null,
        );
      t.default = component.exports;
    }
  }
])
