import test from "node:test";
import assert from "node:assert/strict";
import { cloneRequest, detailRequest } from "../src/contentCore.ts";

const product = {
  id: "product",
  name: "商品",
  url: "data:image/jpeg;base64,eA==",
};
const reference = {
  id: "reference",
  name: "参考",
  url: "data:image/jpeg;base64,eQ==",
};
const detailOptions = {
  products: [product],
  blocks: ["hero", "size"],
  platform: "亚马逊",
  market: "美国",
  language: "英文",
  ratio: "16:9",
  description: "容量 500 ml",
  visualStyle: "浅灰留白",
};
const cloneOptions = {
  products: [product],
  references: [reference],
  type: "电商商品图",
  degree: "close" as const,
  language: "英文",
  ratio: "1:1",
  description: "改为绿色",
  perReference: {},
};

test("detail jobs retain chosen module order and verified product facts", () => {
  const request = detailRequest({ ...detailOptions, blocks: ["size", "hero"] });
  assert.equal(request.jobs.length, 2);
  assert.match(request.jobs[0].title, /尺寸/);
  assert.match(request.jobs[0].prompt, /容量 500 ml/);
  assert.match(request.jobs[0].prompt, /未提供的数值不要猜测/);
  assert.match(request.jobs[1].title, /主视觉/);
  assert.deepEqual(request.products, [product]);
  assert.equal(request.ratio, "16:9");
});

test("detail generation rejects missing inputs or unsupported module ids", () => {
  assert.throws(
    () => detailRequest({ ...detailOptions, products: [] }),
    /上传商品/,
  );
  assert.throws(
    () => detailRequest({ ...detailOptions, blocks: [] }),
    /至少选择/,
  );
  assert.throws(
    () => detailRequest({ ...detailOptions, blocks: ["unknown"] }),
    /至少选择/,
  );
});

test("clone jobs isolate their reference and individual instructions", () => {
  const second = { ...reference, id: "second" };
  const request = cloneRequest({
    ...cloneOptions,
    references: [reference, second],
    perReference: { reference: "保留人物", second: "改成夜景" },
  });
  assert.deepEqual(request.jobs[0].references, [reference]);
  assert.deepEqual(request.jobs[1].references, [second]);
  assert.match(request.jobs[0].prompt, /保留人物/);
  assert.doesNotMatch(request.jobs[0].prompt, /改成夜景/);
  assert.match(request.jobs[1].prompt, /改成夜景/);
  assert.match(request.jobs[0].prompt, /其余输入图是要替换/);
});

test("clone without product replacement changes input instructions", () => {
  const request = cloneRequest({
    ...cloneOptions,
    products: [],
    degree: "style",
  });
  assert.match(request.jobs[0].prompt, /未提供替换商品/);
  assert.match(request.jobs[0].prompt, /重新设计构图/);
  assert.doesNotMatch(request.jobs[0].prompt, /其余输入图是要替换/);
});

test("clone validates reference count before creating a batch", () => {
  assert.throws(
    () => cloneRequest({ ...cloneOptions, references: [] }),
    /上传参考/,
  );
  assert.throws(
    () =>
      cloneRequest({
        ...cloneOptions,
        references: Array.from({ length: 21 }, () => reference),
      }),
    /20 张/,
  );
});
