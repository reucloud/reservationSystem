import express from "express";
import session from "express-session";
import mysql from "mysql2";
const app = express();

// 日本時間（JST）に統一
process.env.TZ = "Asia/Tokyo";

import open from "open";
import path from "path";
import { fileURLToPath } from "url"; // 追加
import fs from "fs"; // 追加: 画像ファイル読み込み用

const __filename = fileURLToPath(import.meta.url); // 追加
const __dirname = path.dirname(__filename); // 追加

const connection = mysql.createPool({
  host: "127.0.0.1",
  user: "root",
  password: "reucloud1412",
  database: "reservation_system",
  charset: "utf8mb4",
  timezone: "+09:00", // JST
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ✅ 接続プール全体のタイムゾーンを設定
connection.query("SET time_zone = '+09:00'", (err) => {
  if (err) {
    console.error("❌ タイムゾーン設定エラー:", err);
  } else {
    console.log("✅ MySQLタイムゾーンを JST (+09:00) に設定しました");
  }
});

// NEW!バッジ機能用のグローバル変数
const newCouponIds = new Set(); // 新しく追加されたクーポンID
const userViewedCoupons = new Map(); // ユーザーID -> 閲覧済みクーポンIDのSet
const updatedCouponIds = new Set(); // 新たに追加・編集されたクーポンID

// ユーザーに未閲覧の新規クーポンがあるかチェックする関数（非同期）
async function hasNewCoupons(userId) {
  if (newCouponIds.size === 0) return false; // 新規クーポンが1つもない

  try {
    // 今月の利用額を計算
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);

    const [sumRows] = await connection.promise().query(
      `
      SELECT COALESCE(SUM(amount),0) AS total
      FROM reservations
      WHERE user_id = ?
        AND status != 'キャンセル'
        AND reserve_day >= ?
        AND reserve_day < ?
      `,
      [userId, startStr, endStr],
    );

    const monthlyTotal = sumRows[0].total;

    // ユーザーが利用可能なクーポンを取得（filter条件を満たすもの）
    const [availableCoupons] = await connection.promise().query(
      `
      SELECT id
      FROM coupons
      WHERE is_open = 1
        AND filter <= ?
      `,
      [monthlyTotal],
    );

    // 利用可能なクーポンIDのSetを作成
    const availableCouponIds = new Set(availableCoupons.map((c) => c.id));

    const viewedCoupons = userViewedCoupons.get(userId) || new Set();

    // 新規クーポンの中に、利用可能でまだ見ていないものがあるか
    for (const id of newCouponIds) {
      if (availableCouponIds.has(id) && !viewedCoupons.has(id)) {
        return true; // 未閲覧の利用可能な新規クーポンが見つかった
      }
    }

    return false; // 全て閲覧済み or 利用不可
  } catch (error) {
    console.error("hasNewCoupons error:", error);
    return false;
  }
}

app.use(express.static(path.join(__dirname, "public"))); //CSS適応
app.use(express.urlencoded({ extended: true })); //ejsファイルから値を持って来れるようにする
app.use(express.json()); // JSON形式のリクエストボディをパース

app.use(
  session({
    secret: "secret-key",
    resave: false,
    saveUninitialized: true,
  }),
);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.get("/", (req, res) => {
  res.render("login", {
    error: "",
  });
});

app.get("/newUser", (req, res) => {
  res.render("newUser.ejs");
});

app.get("/letterBox", async (req, res) => {
  try {
    const id = req.session.userId;
    if (!id) return res.redirect("/");

    await connection
      .promise()
      .query("UPDATE users SET updated_at = NOW() WHERE id = ?", [id]);

    const [userResult] = await connection
      .promise()
      .query("SELECT * FROM users WHERE id = ?", [id]);
    const user = userResult[0];

    const [newsResult] = await connection.promise().query("SELECT * FROM news");
    const news = newsResult;

    res.render("letterBox", {
      users: user,
      news: news,
      id: id,
      hasNewCoupons: await hasNewCoupons(id), // NEW!バッジ表示用
    });
  } catch (error) {
    console.log(error);
    res.status(500).send("Server Error");
  }
});

app.get("/reservationPage", async (req, res) => {
  try {
    const id = req.session.userId;
    if (!id) return res.redirect("/");

    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const startDate = `${month}-01`;

    const endDateObj = new Date(month + "-01");
    endDateObj.setMonth(endDateObj.getMonth() + 1);
    const endDate = endDateObj.toISOString().slice(0, 10);

    await connection
      .promise()
      .query("UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
        id,
      ]);

    const [userResult] = await connection
      .promise()
      .query("SELECT * FROM users WHERE id = ?", [id]);
    const user = userResult[0];

    const [reservationsResult] = await connection.promise().query(
      `SELECT * FROM reservations
         WHERE user_id = ?
           AND reserve_day >= ?
           AND reserve_day < ?
         ORDER BY reserve_day ASC, start_time ASC`,
      [id, startDate, endDate],
    );
    const reservations = reservationsResult;

    res.render("reservationPage", {
      users: user,
      reservation: reservations,
      selectedMonth: month,
      id: id,
      hasNewCoupons: await hasNewCoupons(id), // NEW!バッジ表示用
    });
  } catch (error) {
    console.log(error);
    res.status(500).send("Server Error");
  }
});

app.get("/forgetPassword", (req, res) => {
  res.render("forgetPassword.ejs");
});

app.get("/adminCoupons", (req, res) => {
  const id = req.session.userId;

  // ログインチェック
  if (!id) return res.redirect("/");

  // 画像ディレクトリから画像ファイル一覧を取得
  const imagesDir = path.join(__dirname, "public", "images");
  let imageFiles = [];
  try {
    const files = fs.readdirSync(imagesDir);
    // 画像ファイルのみをフィルタ（.png, .jpg, .jpeg, .gif, .webpなど）
    imageFiles = files.filter((file) =>
      /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(file),
    );
  } catch (error) {
    console.error("Error reading images directory:", error);
  }

  connection.query(
    "UPDATE users SET updated_at = NOW() WHERE id = ?",
    [id],
    (error) => {
      if (error) throw error;
      connection.query(
        "SELECT * FROM users WHERE id = ?",
        [id],
        (error, userresults) => {
          if (error) throw error;

          // ユーザーが見つからない場合はログインページへ
          if (!userresults || userresults.length === 0) {
            return res.redirect("/");
          }

          const user = userresults[0];
          connection.query(
            "SELECT * FROM coupons ORDER BY code ",
            (error, results) => {
              if (error) throw error;

              // ユーザーが閲覧済みのクーポンを取得
              const viewedCoupons = userViewedCoupons.get(id) || new Set();

              // 各クーポンに isNew フラグを追加
              const coupons = results.map((coupon) => ({
                ...coupon,
                isNew:
                  (newCouponIds.has(coupon.id) ||
                    updatedCouponIds.has(coupon.id)) &&
                  !viewedCoupons.has(coupon.id) &&
                  coupon.is_open === 1 &&
                  new Date() >= new Date(coupon.start_date) &&
                  new Date() <= new Date(coupon.finish_date),
              }));

              // ページを表示したら、全てのクーポンを「閲覧済み」にする
              if (!userViewedCoupons.has(id)) {
                userViewedCoupons.set(id, new Set());
              }
              results.forEach((coupon) => {
                userViewedCoupons.get(id).add(coupon.id);
              });

              res.render("adminCoupons", {
                users: user,
                coupons: coupons || [],
                id: id,
                imageFiles: imageFiles, // 画像ファイルリストを渡す
              });
            },
          );
        },
      );
    },
  );
});

app.get("/salesManagement", (req, res) => {
  const id = req.session.userId;
  const month = req.query.month;

  const selectedMonth = month || new Date().toISOString().slice(0, 7); // 今月

  const startDate = `${selectedMonth}-01`;
  const endDateObj = new Date(selectedMonth + "-01");
  endDateObj.setMonth(endDateObj.getMonth() + 1);
  const endDate = endDateObj.toISOString().slice(0, 10);

  // 前月の日付範囲を計算
  const prevMonthObj = new Date(selectedMonth + "-01");
  prevMonthObj.setMonth(prevMonthObj.getMonth() - 1);
  const prevStartDate =
    prevMonthObj.toISOString().slice(0, 10).slice(0, 8) + "01";
  const prevEndDate = startDate; // 今月の開始日 = 前月の終了日

  if (!id) return res.redirect("/");

  // 更新時間更新
  connection.query(
    "UPDATE users SET updated_at = NOW() WHERE id = ?",
    [id],
    (error) => {
      if (error) throw error;

      // ユーザー情報取得
      connection.query(
        "SELECT * FROM users WHERE id = ?",
        [id],
        (error, userResults) => {
          if (error) throw error;
          const user = userResults[0];

          // 売上合計
          const salesSql = `
            SELECT
              SUM(amount) AS total_sales
            FROM reservations
            WHERE status != 'キャンセル'
              AND reserve_day >= ? AND reserve_day < ?
          `;

          // 前月の売上合計
          const prevSalesSql = `
            SELECT
              SUM(amount) AS total_sales
            FROM reservations
            WHERE status != 'キャンセル'
              AND reserve_day >= ? AND reserve_day < ?
          `;

          // サービス別ランキング
          const resourceRankingSql = `
            SELECT
              resources.name AS resource_name,
              SUM(reservations.amount) AS total_amount
            FROM reservations
            JOIN resources ON reservations.resource_id = resources.id
            WHERE reservations.status != 'キャンセル'
              AND reservations.reserve_day >= ? AND reservations.reserve_day < ?
            GROUP BY resources.id
            ORDER BY total_amount DESC
          `;

          // 日別売上（折れ線グラフ用・ユーザー名も含む）
          const dailySalesSql = `
            SELECT
              DATE(reservations.reserve_day) AS date,
              SUM(reservations.amount) AS total,
              GROUP_CONCAT(DISTINCT users.name SEPARATOR ', ') AS user_names
            FROM reservations
            JOIN users ON reservations.user_id = users.id
            WHERE reservations.status != 'キャンセル'
              AND reservations.reserve_day >= ? 
              AND reservations.reserve_day < ?
            GROUP BY DATE(reservations.reserve_day)
            ORDER BY DATE(reservations.reserve_day)
          `;

          //ユーザー別ランキング
          const userRankingSql = `
          SELECT
            users.id,
            users.name AS user_name,
            SUM(reservations.amount) AS total_amount
          FROM reservations
          JOIN users ON reservations.user_id = users.id
          WHERE reservations.status != 'キャンセル'
            AND reservations.reserve_day >= ? AND reservations.reserve_day < ?
          GROUP BY users.id, users.name
          ORDER BY total_amount DESC
          `;

          connection.query(
            salesSql,
            [startDate, endDate],
            (error, salesResult) => {
              if (error) throw error;
              const totalSales = salesResult[0].total_sales || 0;

              // 前月の売上を取得
              connection.query(
                prevSalesSql,
                [prevStartDate, prevEndDate],
                (error, prevSalesResult) => {
                  if (error) throw error;
                  const prevTotalSales = prevSalesResult[0].total_sales || 0;

                  connection.query(
                    resourceRankingSql,
                    [startDate, endDate],
                    (error, resourceRankingResult) => {
                      if (error) throw error;

                      connection.query(
                        dailySalesSql,
                        [startDate, endDate],
                        (error, dailySalesResult) => {
                          if (error) throw error;

                          connection.query(
                            userRankingSql,
                            [startDate, endDate],
                            (error, userRankingResult) => {
                              if (error) throw error;

                              // 計画売上を取得
                              connection.query(
                                "SELECT target_amount FROM sales_targets WHERE month = ?",
                                [selectedMonth],
                                (error, targetResult) => {
                                  if (error) throw error;

                                  const targetAmount =
                                    targetResult.length > 0
                                      ? targetResult[0].target_amount
                                      : 0;

                                  res.render("salesManagement", {
                                    users: user,
                                    totalSales,
                                    prevTotalSales, // 前月売上を追加
                                    targetAmount, // 計画売上を追加
                                    ranking: resourceRankingResult || [],
                                    dailySales: dailySalesResult || [],
                                    userRanking: userRankingResult || [],
                                    selectedMonth,
                                    id: id,
                                  });
                                },
                              );
                            },
                          );
                        },
                      );
                    },
                  );
                },
              );
            },
          );
        },
      );
    },
  );
});

app.post("/couponInput", (req, res) => {
  const couponName = req.body.name;
  const couponCode = req.body.code;
  const discountWay = req.body.type;
  const discount = req.body.discount;
  const filter = req.body.filter === "" ? 0 : req.body.filter;
  // 日付を YYYY-MM-DD 形式でそのまま保存（タイムゾーンずれ防止）
  const start_date = req.body.start_date;
  const finish_date = req.body.finish_date;
  const couponPhoto = req.body.image || ""; // フォームから'image'として送信される
  const service = Array.isArray(req.body.service)
    ? req.body.service.join(",")
    : req.body.service;
  const memo = req.body.memo === "" ? null : req.body.memo;
  const isOpen = req.body.open === "open" ? 1 : 0;

  connection.query(
    "INSERT INTO coupons (name, code, type, discount, filter, start_date, finish_date, photo, service, memo, is_open) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      couponName,
      couponCode,
      discountWay,
      discount,
      filter,
      start_date,
      finish_date,
      couponPhoto,
      service,
      memo,
      isOpen,
    ],
    (error, result) => {
      if (error) throw error;

      // 新しいクーポンIDをグローバル変数に追加（insertIdは自動採番されたID）
      newCouponIds.add(result.insertId);

      res.redirect("/adminCoupons");
    },
  );
});

app.get("/adminCoupons/edit/:id", (req, res) => {
  const couponId = req.params.id;

  // 画像ディレクトリから画像ファイル一覧を取得
  const imagesDir = path.join(__dirname, "public", "images");
  let imageFiles = [];
  try {
    const files = fs.readdirSync(imagesDir);
    imageFiles = files.filter((file) =>
      /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(file),
    );
  } catch (error) {
    console.error("Error reading images directory:", error);
  }

  connection.query(
    `SELECT
      *,
      DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date_str,
      DATE_FORMAT(finish_date, '%Y-%m-%d') AS finish_date_str
    FROM coupons
    WHERE id = ?`,
    [couponId],
    (error, results) => {
      if (error) throw error;

      res.render("adminCouponEdit", {
        coupon: results[0],
        imageFiles: imageFiles,
      });
    },
  );
});

app.post("/adminCoupons/edit/:id", (req, res) => {
  const couponId = req.params.id;

  const {
    name,
    code,
    type,
    discount,
    filter,
    start_date,
    finish_date,
    photo,
    memo,
  } = req.body;

  const isOpen = req.body.open === "open" ? 1 : 0;

  // checkbox（配列）対策
  let service = req.body.service;
  if (Array.isArray(service)) {
    service = service.join(","); // "massage,cooking"
  }

  const sql = `
    UPDATE coupons
    SET
      name = ?,
      code = ?,
      type = ?,
      discount = ?,
      filter = ?,
      start_date = ?,
      finish_date = ?,
      photo = ?,
      service = ?,
      memo = ?,
      is_open = ?
    WHERE id = ?
  `;

  connection.query(
    sql,
    [
      name,
      code,
      type,
      discount,
      filter || 0,
      start_date,
      finish_date,
      photo,
      service,
      memo,
      isOpen,
      couponId,
    ],
    (error) => {
      if (error) throw error;
      updatedCouponIds.add(Number(couponId));

      // 更新後は一覧へ戻す
      res.redirect("/adminCoupons");
    },
  );
});

app.post("/adminCoupons/delete/:id", (req, res) => {
  const couponId = req.params.id;

  connection.query("DELETE FROM coupons WHERE id = ?", [couponId], (error) => {
    if (error) throw error;
    res.redirect("/adminCoupons");
  });
});

app.post("/newsInput", (req, res) => {
  const { title, start_date, finish_date, contents } = req.body;

  connection.query(
    "INSERT INTO news (name, start_date, finish_date, contents) VALUES (?,?,?,?)",
    [title, start_date, finish_date, contents],
    (error, result) => {
      if (error) throw error;
      res.redirect("/adminNews");
    },
  );
});

app.get("/adminNews", (req, res) => {
  const id = req.session.userId;
  connection.query(
    "UPDATE users SET updated_at = NOW() WHERE id = ?",
    [id],
    (error) => {
      if (error) throw error;
      connection.query(
        "SELECT * FROM users WHERE id = ?",
        [id],
        (error, userresults) => {
          if (error) throw error;
          const user = userresults[0];
          connection.query(
            "SELECT * FROM news ORDER BY create_at DESC",
            (error, newsresults) => {
              if (error) throw error;
              const news = newsresults;
              res.render("adminNews", {
                users: user,
                news: news || [],
                id: id,
              });
            },
          );
        },
      );
    },
  );
});

app.get("/adminNews/edit/:id", (req, res) => {
  const newsId = req.params.id;

  connection.query(
    `SELECT
      *,
      DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date_str,
      DATE_FORMAT(finish_date, '%Y-%m-%d') AS finish_date_str
    FROM news
    WHERE id = ?`,
    [newsId],
    (error, results) => {
      if (error) throw error;

      res.render("adminNewsEdit", {
        news: results[0],
      });
    },
  );
});

app.post("/adminNews/edit/:id", (req, res) => {
  const newsId = req.params.id;

  const { title, start_date, finish_date, contents } = req.body;

  connection.query(
    "UPDATE news SET name = ?, start_date = ?, finish_date = ?, contents = ? WHERE id = ?",
    [title, start_date, finish_date, contents, newsId],
    (error, results) => {
      if (error) throw error;
      res.redirect("/adminNews");
    },
  );
});

app.post("/adminNews/delete/:id", (req, res) => {
  const newsId = req.params.id;

  connection.query("DELETE FROM news WHERE id = ?", [newsId], (error) => {
    if (error) throw error;
    res.redirect("/adminNews");
  });
});

app.get("/charge", async (req, res) => {
  const id = req.session.userId;
  const role = req.session.role;

  try {
    await connection
      .promise()
      .query("UPDATE users SET updated_at = NOW() WHERE id = ?", [id]);

    const [userResult] = await connection
      .promise()
      .query("SELECT * FROM users WHERE id = ?", [id]);
    const user = userResult[0];

    if (role === "admin") {
      res.redirect("/adminCharge");
    } else {
      console.log(user);
      res.render("charge", {
        users: user,
        id: id,
        hasNewCoupons: await hasNewCoupons(id), // NEW!バッジ表示用
      });
    }
  } catch (error) {
    console.error(error);
    res.status(500).send("Server Error");
  }
});

app.post("/charge", (req, res) => {
  const targetUserId = req.body.targetUserId;
  const charge = Number(req.body.charge);
  const type = req.body.type; // "charge" or "point"

  if (type === "charge") {
    if (!targetUserId) {
      return res.redirect("/adminCharge");
    }

    connection.query(
      "UPDATE users SET charge = charge + ? WHERE id = ?",
      [charge, targetUserId],
      (error, results) => {
        if (error) throw error;
        res.redirect("/charge");
      },
    );
  } else if (type === "point") {
    connection.query(
      "UPDATE users SET point = point + ? WHERE id = ?",
      [charge, targetUserId],
      (error, results) => {
        if (error) throw error;
        res.redirect("/adminCharge");
      },
    );
  } else if (type === "ticket") {
    connection.query(
      "UPDATE users SET ticket = ticket + ? WHERE id = ?",
      [charge, targetUserId],
      (error, results) => {
        if (error) throw error;
        res.redirect("/adminCharge");
      },
    );
  }
});

app.get("/coupons", async (req, res) => {
  const id = req.session.userId;
  if (!id) return res.redirect("/");

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  // 今月の利用額
  const [sumRows] = await connection.promise().query(
    `
    SELECT COALESCE(SUM(amount),0) AS total
    FROM reservations
    WHERE user_id = ?
      AND status = '提供済'
      AND reserve_day >= ?
      AND reserve_day < ?
    `,
    [id, startStr, endStr],
  );

  const monthlyTotal = sumRows[0].total;

  // filter 条件を満たすクーポンだけ表示
  const [coupons] = await connection.promise().query(
    `
    SELECT *
    FROM coupons
    WHERE is_open = 1
      AND filter <= ?
    ORDER BY code
    `,
    [monthlyTotal],
  );

  const [user] = await connection
    .promise()
    .query("SELECT * FROM users WHERE id = ?", [id]);

  // ユーザーが閲覧済みのクーポンを取得
  const viewedCoupons = userViewedCoupons.get(id) || new Set();

  // 各クーポンに isNew フラグを追加
  const couponsWithNewFlag = coupons.map((coupon) => ({
    ...coupon,
    isNew:
      (newCouponIds.has(coupon.id) || updatedCouponIds.has(coupon.id)) &&
      !viewedCoupons.has(coupon.id) &&
      coupon.is_open === 1 &&
      new Date() >= new Date(coupon.start_date) &&
      new Date() <= new Date(coupon.finish_date),
  }));

  // ページを表示したら、全てのクーポンを「閲覧済み」にする
  if (!userViewedCoupons.has(id)) {
    userViewedCoupons.set(id, new Set());
  }
  coupons.forEach((coupon) => {
    userViewedCoupons.get(id).add(coupon.id);
  });

  res.render("coupons", {
    users: user[0],
    coupons: couponsWithNewFlag,
    id,
    hasNewCoupons: false, // クーポンページでは閲覧後なのでfalse
  });
});

app.get("/top", async (req, res) => {
  const id = req.session.userId;
  if (!id) return res.redirect("/");

  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const startDate = `${month}-01`;
  const endDate = new Date(month + "-01");
  endDate.setMonth(endDate.getMonth() + 1);

  const endDateStr = endDate.toISOString().slice(0, 10);

  try {
    await connection
      .promise()
      .query("UPDATE users SET updated_at = NOW() WHERE id = ?", [id]);

    const [userResult] = await connection
      .promise()
      .query("SELECT * FROM users WHERE id = ?", [id]);
    const user = userResult[0];

    const [newsResult] = await connection
      .promise()
      .query("SELECT * FROM news ORDER BY create_at DESC");
    const news = newsResult;

    const [reservations] = await connection.promise().query(
      `
      SELECT *
      FROM reservations
      WHERE user_id = ?
        AND reserve_day >= ?
        AND reserve_day < ?
      ORDER BY reserve_day ASC, start_time ASC
      `,
      [id, startDate, endDateStr],
    );

    const [resourceResult] = await connection
      .promise()
      .query("SELECT * FROM resources ORDER BY id ASC");
    const resources = resourceResult;

    res.render("top", {
      users: user,
      news: news || [],
      reservation: reservations || [],
      id: id,
      couponError: 0,
      selectedMonth: month,
      couponCode: "", // クーポンコードエラー用の変数を追加
      resources: resources || [],
      hasNewCoupons: await hasNewCoupons(id), // NEW!バッジ表示用
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Server Error");
  }
});

app.get("/top/:couponCode", async (req, res) => {
  const id = req.session.userId;
  if (!id) return res.redirect("/");

  const couponCode = req.params.couponCode;

  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const startDate = `${month}-01`;
  const endDate = new Date(month + "-01");
  endDate.setMonth(endDate.getMonth() + 1);

  const endDateStr = endDate.toISOString().slice(0, 10);

  try {
    await connection
      .promise()
      .query("UPDATE users SET updated_at = NOW() WHERE id = ?", [id]);

    const [userResult] = await connection
      .promise()
      .query("SELECT * FROM users WHERE id = ?", [id]);
    const user = userResult[0];

    const [newsResult] = await connection
      .promise()
      .query("SELECT * FROM news ORDER BY create_at DESC");
    const news = newsResult;

    const [resourceResult] = await connection
      .promise()
      .query("SELECT * FROM resources ORDER BY id ASC");
    const resources = resourceResult;

    const [reservations] = await connection.promise().query(
      `
      SELECT *
      FROM reservations
      WHERE user_id = ?
        AND reserve_day >= ?
        AND reserve_day < ?
      ORDER BY reserve_day ASC, start_time ASC
      `,
      [id, startDate, endDateStr],
    );

    res.render("top", {
      users: user,
      news: news || [],
      reservation: reservations || [],
      id: id,
      couponError: 0,
      selectedMonth: month,
      resources: resources || [],
      couponCode: couponCode, // クーポンコードを渡す
      hasNewCoupons: await hasNewCoupons(id), // NEW!バッジ表示用
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Server Error");
  }
});

app.post("/login", (req, res) => {
  const mail = req.body.mail;
  const password = req.body.password;

  connection.query(
    "SELECT * FROM users WHERE email = ?",
    [mail],
    (error, results) => {
      if (error) {
        return res.redirect("/");
      }

      if (results.length > 0 && password === results[0].password) {
        req.session.userId = results[0].id;
        req.session.role = results[0].role;

        if (results[0].role === "admin") {
          return res.redirect("/adminTop");
        } else {
          return res.redirect("/top");
        }
      } else {
        return res.render("login", {
          error: "メールアドレスまたはパスワードが正しくありません",
        });
      }
    },
  );
});

app.post("/newUser", (req, res) => {
  const username = req.body.name;
  const mail = req.body.email;
  const password = req.body.password;
  const password2 = req.body.password2;
  let role = "user";
  const errors = [];

  if (username === "") {
    errors.push("名前が空欄です");
  }
  if (mail === "") {
    errors.push("メールアドレスが空欄です");
  }
  if (password === "" || password2 === "") {
    errors.push("パスワード欄が空欄です");
  }
  if (password !== password2) {
    errors.push("パスワード欄の値が一致しません");
  }
  if (errors.length > 0) {
    return res.render("newUser.ejs", { errors: errors });
  }
  if (mail === "yuma20040824@icloud.com" && password === "reucloud1412") {
    role = "admin";
  }

  connection.query(
    "SELECT * FROM users WHERE email = ?",
    [mail],
    (error, results) => {
      if (error) {
        console.log("error");
        throw error;
      }

      if (results.length > 0) {
        // console.log("already");
        errors.push("このユーザー名はすでに使用されています");
        return res.render("newUser.ejs", { errors });
      }

      // 重複がない場合、新規登録
      connection.query(
        "INSERT INTO users (name, charge, password, email, role) VALUES (?, ?,?,?,?)",
        [username, 0, password, mail, role],
        (error, results) => {
          if (error) throw error;
          // console.log("✅ 新規ユーザー登録:", username);

          // req.session.userId = results.insertId; // 挿入されたユーザーのID
          // req.session.username = username;

          req.session.userId = results.insertId;
          res.redirect("/top");
        },
      );
    },
  );
});

app.post("/reservation", async (req, res) => {
  const id = req.session.userId;
  if (!id) return res.redirect("/");

  const { reserve_day, start_time, usage_time, coupon, memo } = req.body;
  const resource = req.body.resource;
  const month = new Date().toISOString().slice(0, 7);
  const usePoint = Number(req.body.point) || 0;
  const ticket = Number(req.body.ticket) || 0;

  try {
    const amount = await AmountCheck(resource, usage_time, coupon);

    // ① updated_at 更新
    await connection
      .promise()
      .query("UPDATE users SET updated_at = NOW() WHERE id = ?", [id]);

    // ② users を必ず取得
    const [userResults] = await connection
      .promise()
      .query("SELECT * FROM users WHERE id = ?", [id]);
    const user = userResults[0];

    if (amount === -1 || amount === -2 || amount === -3) {
      // ③ クーポン無効時
      const [newsResults] = await connection
        .promise()
        .query("SELECT * FROM news ORDER BY create_at DESC");

      const [reservations] = await connection
        .promise()
        .query("SELECT * FROM reservations WHERE user_id = ?", [id]);

      const [resourceResult] = await connection
        .promise()
        .query("SELECT * FROM resources ORDER BY id ASC");
      const resources = resourceResult;

      res.render("top", {
        users: user,
        news: newsResults || [],
        reservation: reservations || [],
        id,
        couponError: amount,
        couponCode: "", // クーポンコードエラー用の変数を追加
        selectedMonth: month,
        hasNewCoupons: await hasNewCoupons(id),
        resources: resources || [],
      });
      return;
    } else {
      // ④ ポイント適用後最終金額確定
      let finalAmount = amount - usePoint;
      if (finalAmount < 0) finalAmount = 0;

      let earnedPoints = 0; // ✅ 初期化

      // ⑤ ポイント処理
      if (usePoint > 0) {
        // ポイント使用時: point（残高）を減らすのみ（付与なし）
        await connection
          .promise()
          .query("UPDATE users SET point = point - ? WHERE id = ?", [
            usePoint,
            id,
          ]);
      }

      earnedPoints = Math.floor(finalAmount * 0.03); // 3%のポイントを付与
      await connection
        .promise()
        .query("UPDATE users SET point = point + ? WHERE id = ?", [
          earnedPoints,
          id,
        ]);

      // ⑥ 予約をDBに登録
      await connection.promise().query(
        `INSERT INTO reservations
         (user_id, reserve_day, start_time, usage_time, resource_id, coupon_code, memo, amount, status, point, use_point, ticket)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          reserve_day,
          start_time,
          usage_time,
          resource,
          coupon,
          memo,
          finalAmount,
          "承認前",
          earnedPoints, // ✅ 付与したポイント数（使用時は0）
          usePoint, // ✅ 使用したポイント数
          ticket, // ✅ 使用したチケット数
        ],
      );

      res.redirect("/top");
    }
  } catch (error) {
    console.error(error);
    res.status(500).send("Server Error");
  }
});

app.post("/reservation/status/update", (req, res) => {
  const { reservationId, newStatus } = req.body;

  // ① 変更前の予約情報を取得
  connection.query(
    "SELECT status, amount, user_id, point, use_point FROM reservations WHERE id = ?",
    [reservationId],
    (err, rows) => {
      if (err) throw err;
      if (rows.length === 0) return res.sendStatus(404);

      const oldStatus = rows[0].status;
      const amount = rows[0].amount;
      const userId = rows[0].user_id;
      const earnedPoints = rows[0].point;
      const usedPoint = rows[0].use_point;

      // ② ステータスを更新
      connection.query(
        "UPDATE reservations SET status = ? WHERE id = ?",
        [newStatus, reservationId],
        (err) => {
          if (err) throw err;

          // ③ チャージ調整（提供済みの場合のみ）
          if (oldStatus !== "提供済み" && newStatus === "提供済み") {
            connection.query(
              "UPDATE users SET charge = charge - ? WHERE id = ?",
              [amount, userId],
            );
          }

          if (oldStatus === "提供済み" && newStatus !== "提供済み") {
            connection.query(
              "UPDATE users SET charge = charge + ? WHERE id = ?",
              [amount, userId],
            );
          }

          // ④ ポイント調整
          if (oldStatus !== "キャンセル" && newStatus === "キャンセル") {
            // 使用したポイントを返す
            if (usedPoint > 0) {
              connection.query(
                "UPDATE users SET point = point + ? WHERE id = ?",
                [usedPoint, userId],
              );
            }

            // 付与したポイントを減らす
            if (earnedPoints > 0) {
              connection.query(
                "UPDATE users SET point = point - ? WHERE id = ?",
                [earnedPoints, userId],
              );
            }
          }

          if (oldStatus === "キャンセル" && newStatus !== "キャンセル") {
            // 使用ポイントを再度減らす
            if (usedPoint > 0) {
              connection.query(
                "UPDATE users SET point = point - ? WHERE id = ?",
                [usedPoint, userId],
              );
            }

            // 付与ポイントを再度付与
            if (earnedPoints > 0) {
              connection.query(
                "UPDATE users SET point = point + ? WHERE id = ?",
                [earnedPoints, userId],
              );
            }
          }

          res.redirect("/adminTop");
        },
      );
    },
  );
});

// クーポンコードを反映し価格を返す関数
async function AmountCheck(resource, usage_time, couponCode) {
  // リソースのid、名前、価格をDBから取得
  const [resourceRows] = await connection
    .promise()
    .query("SELECT id, name, price FROM resources WHERE id = ?", [resource]);

  // リソースチェック(無ければ0を返す)
  if (resourceRows.length === 0) return 0;

  const { name, price } = resourceRows[0];
  let amount = price * (Number(usage_time) / 10);

  // クーポンコードが未入力なら定価を返す
  if (!couponCode) return Math.floor(amount);

  // コードが有効かどうか確認
  const [couponRows] = await connection
    .promise()
    .query("SELECT * FROM coupons WHERE code = ? AND is_open = 1", [
      couponCode,
    ]);

  // 有効で無ければエラーを返す
  if (couponRows.length === 0) return -1;
  const coupon = couponRows[0];

  // 今日の日付を取得し不正な日付じゃないか確認
  const today = new Date();
  const startDate = new Date(coupon.start_date);
  const finishDate = new Date(coupon.finish_date);

  if (isNaN(startDate) || isNaN(finishDate)) return -2;

  if (today < startDate || today > finishDate) {
    return -2;
  }

  // サービスが使用かどうか確認
  const services = coupon.service.split(",");
  if (!services.includes(name)) return -3;

  // 割引処理
  if (coupon.type === "yen") amount -= coupon.discount;
  if (coupon.type === "percent") amount *= 1 - coupon.discount / 100;

  // 負の値にならないようにする
  if (amount < 0) amount = 0;

  // 値を返す
  return Math.floor(amount);
}

// 予約ステータス更新&チャージ調整API
// 予約ステータス更新&チャージ調整API
app.post("/reservation/status/update", (req, res) => {
  const { reservationId, newStatus } = req.body;

  // ① 変更前の予約情報を取得
  connection.query(
    "SELECT status, amount, user_id, point, use_point FROM reservations WHERE id = ?",
    [reservationId],
    (err, rows) => {
      if (err) throw err;
      if (rows.length === 0) return res.sendStatus(404);

      const oldStatus = rows[0].status;
      const amount = rows[0].amount;
      const userId = rows[0].user_id;
      const earnedPoints = rows[0].point; // 付与したポイント
      const usedPoint = rows[0].use_point; // 使用したポイント

      console.log("予約情報:", {
        reservationId,
        oldStatus,
        newStatus,
        earnedPoints,
        usedPoint,
        userId,
      });

      // ② ステータスを更新
      connection.query(
        "UPDATE reservations SET status = ? WHERE id = ?",
        [newStatus, reservationId],
        (err) => {
          if (err) throw err;

          // ③ チャージ調整（提供済みの場合のみ）
          if (oldStatus !== "提供済み" && newStatus === "提供済み") {
            connection.query(
              "UPDATE users SET charge = charge - ? WHERE id = ?",
              [amount, userId],
            );
          }

          if (oldStatus === "提供済み" && newStatus !== "提供済み") {
            connection.query(
              "UPDATE users SET charge = charge + ? WHERE id = ?",
              [amount, userId],
            );
          }

          // ④ ポイント調整
          if (oldStatus !== "キャンセル" && newStatus === "キャンセル") {
            // キャンセルになった場合

            // 使用したポイントを返す
            if (usedPoint > 0) {
              console.log(
                `使用ポイント返却: ${usedPoint}P をユーザー${userId}に返却`,
              );
              connection.query(
                "UPDATE users SET point = point + ? WHERE id = ?",
                [usedPoint, userId],
                (err) => {
                  if (err) console.error("ポイント返却エラー:", err);
                  else console.log("ポイント返却成功");
                },
              );
            }

            // 付与したポイントを減らす
            if (earnedPoints > 0) {
              console.log(
                `付与ポイント減算: ${earnedPoints}P をユーザー${userId}から減算`,
              );
              connection.query(
                "UPDATE users SET point = point - ? WHERE id = ?",
                [earnedPoints, userId],
                (err) => {
                  if (err) console.error("ポイント減算エラー:", err);
                  else console.log("ポイント減算成功");
                },
              );
            }
          }

          if (oldStatus === "キャンセル" && newStatus !== "キャンセル") {
            // キャンセルから戻った場合

            // 使用ポイントを再度減らす
            if (usedPoint > 0) {
              console.log(
                `使用ポイント再減算: ${usedPoint}P をユーザー${userId}から減算`,
              );
              connection.query(
                "UPDATE users SET point = point - ? WHERE id = ?",
                [usedPoint, userId],
              );
            }

            // 付与ポイントを再度付与
            if (earnedPoints > 0) {
              console.log(
                `付与ポイント再付与: ${earnedPoints}P をユーザー${userId}に付与`,
              );
              connection.query(
                "UPDATE users SET point = point + ? WHERE id = ?",
                [earnedPoints, userId],
              );
            }
          }

          res.redirect("/adminTop");
        },
      );
    },
  );
});

app.get("/adminTop", (req, res) => {
  const id = req.session.userId;
  const range = req.query.range;
  const excludeProvided = req.query.excludeProvided === "1";

  // 月の取得
  const month = req.query.month
    ? req.query.month
    : new Date().toISOString().slice(0, 7);

  // 日数始めの取得
  const startDate = `${month}-01`;

  // 日数終りの修正•取得
  const endDateObj = new Date(month + "-01");
  endDateObj.setMonth(endDateObj.getMonth() + 1);
  const endDate = endDateObj.toISOString().slice(0, 10);

  let reservationSql = "";
  if (!id) return res.redirect("/"); // ログインしていなければ戻す

  if (range === "today") {
    reservationSql = `
    SELECT
      reservations.*,
      DATE_FORMAT(reservations.reserve_day, '%Y-%m-%d') AS reserve_day_str,
      users.name AS user_name,
      resources.name AS resource_name
    FROM reservations
    JOIN users ON reservations.user_id = users.id
    JOIN resources ON reservations.resource_id = resources.id
    WHERE DATE(reservations.reserve_day) = CURDATE() 
      AND reserve_day >= ?
      AND reserve_day < ?
    ${excludeProvided ? "AND reservations.status != '提供済'" : ""}
    ORDER BY reservations.start_time ASC
`;
  } else {
    reservationSql = `
  SELECT
    reservations.*,
    DATE_FORMAT(reservations.reserve_day, '%Y-%m-%d') AS reserve_day_str,
    users.name AS user_name,
    resources.name AS resource_name
  FROM reservations
  JOIN users ON reservations.user_id = users.id
  JOIN resources ON reservations.resource_id = resources.id
  WHERE reservations.reserve_day >= ?
    AND reservations.reserve_day < ?
    ${excludeProvided ? "AND reservations.status != '提供済'" : ""}
  ORDER BY reservations.reserve_day ASC, reservations.start_time ASC
    `;
  }

  // DB上の更新時間を更新
  connection.query(
    "UPDATE users SET updated_at = NOW() WHERE id = ?",
    [id],
    (error) => {
      if (error) throw error;

      // 更新後にユーザー情報を取得して画面表示
      connection.query(
        "SELECT * FROM users WHERE id = ?",
        [id],
        (error, userresults) => {
          if (error) throw error;
          const user = userresults[0];
          connection.query(
            "SELECT * FROM news ORDER BY create_at DESC",
            (error, results) => {
              if (error) throw error;
              const news = results;
              connection.query(
                reservationSql,
                [startDate, endDate],
                (error, reservations) => {
                  if (error) throw error;
                  const reserve = reservations;
                  res.render("adminTop", {
                    users: user,
                    news: news || [],
                    reservation: reserve || [],
                    id: id,
                    couponError: false,
                    excludeProvided,
                    selectedMonth: month,
                    range: req.query.range || "",
                  });
                },
              );
            },
          );
        },
      );
    },
  );
});

app.post("/adminTop/delete/:id", async (req, res) => {
  const topId = req.params.id;

  try {
    const [rows] = await connection
      .promise()
      .query(
        "SELECT user_id, point, use_point, status, amount, is_charged FROM reservations WHERE id = ?",
        [topId],
      );

    if (rows.length === 0) {
      return res.redirect("/adminTop");
    }

    const reservation = rows[0];

    await connection
      .promise()
      .query("DELETE FROM reservations WHERE id = ?", [topId]);

    if (reservation.status !== "キャンセル") {
      // 使用したポイントを返す
      if (reservation.use_point > 0) {
        await connection
          .promise()
          .query("UPDATE users SET point = point + ? WHERE id = ?", [
            reservation.use_point,
            reservation.user_id,
          ]);
      }

      // 付与したポイントを減らす
      if (reservation.point > 0) {
        await connection
          .promise()
          .query("UPDATE users SET point = point - ? WHERE id = ?", [
            reservation.point,
            reservation.user_id,
          ]);
      }

      // チャージ調整（提供済みで既にチャージ減算済みの場合）
      if (reservation.status === "提供済" && reservation.is_charged === 1) {
        await connection
          .promise()
          .query("UPDATE users SET charge = charge + ? WHERE id = ?", [
            reservation.amount,
            reservation.user_id,
          ]);
      }
    }

    res.redirect("/adminTop");
  } catch (error) {
    console.error(error);
    res.redirect("/adminTop");
  }
});

app.get("/adminTop/edit/:id", (req, res) => {
  const topId = req.params.id;

  const sql = `
    SELECT
      reservations.*,
      DATE_FORMAT(reservations.reserve_day, '%Y-%m-%d') AS reserve_day_str,
      users.name AS user_name,
      resources.name AS resource_name,
      coupons.name AS coupon_name
    FROM reservations
    JOIN users ON reservations.user_id = users.id
    JOIN resources ON reservations.resource_id = resources.id
    LEFT JOIN coupons ON reservations.coupon_code = coupons.code
    WHERE reservations.id = ?
  `;

  connection.query(sql, [topId], async (error, result) => {
    if (error) {
      console.error("SQL実行エラー:", error);
      return res.status(500).send("Server Error");
    }

    if (!result || result.length === 0) {
      return res.redirect("/adminTop");
    }

    const [resourceResult] = await connection
      .promise()
      .query("SELECT * FROM resources ORDER BY id ASC");
    const resources = resourceResult;

    res.render("adminTopEdit.ejs", {
      reserve: result[0],
      resources: resources || [],
    });
  });
});

app.post("/adminTop/edit/:id", async (req, res) => {
  const editId = req.params.id;
  const {
    status,
    coupon_code,
    point, // 使用ポイント（フォームから）
    addPoint, // 付与ポイント（フォームから）
    reserve_day,
    start_time,
    usage_time,
    amount,
    memo,
    resource_id,
    ticket,
  } = req.body;

  console.log("受信データ:", req.body);

  try {
    const [rows] = await connection
      .promise()
      .query(
        "SELECT user_id, amount, status, is_charged, point, use_point FROM reservations WHERE id = ?",
        [editId],
      );

    if (rows.length === 0) {
      console.log("予約が見つかりません:", editId);
      return res.redirect("/adminTop");
    }

    const reservation = rows[0];
    const oldUsePoint = reservation.use_point; // 編集前の使用ポイント
    const oldAddPoint = reservation.point; // 編集前の付与ポイント
    const oldAmount = reservation.amount; // 編集前の金額
    const newUsePoint = Number(point) || 0; // 編集後の使用ポイント
    const newAddPoint = Number(addPoint) || 0; // 編集後の付与ポイント
    const newAmount = Number(amount); // 編集後の金額

    console.log("編集前の予約情報:", reservation);
    console.log("変更内容:", {
      使用ポイント: `${oldUsePoint} → ${newUsePoint}`,
      付与ポイント: `${oldAddPoint} → ${newAddPoint}`,
      金額: `${oldAmount} → ${newAmount}`,
      ステータス: `${reservation.status} → ${status}`,
    });

    // ===== ステップ1: 編集前の状態をリセット =====

    // チャージをリセット（提供済の場合）
    if (reservation.status === "提供済" && reservation.is_charged === 1) {
      await connection
        .promise()
        .query("UPDATE users SET charge = charge + ? WHERE id = ?", [
          oldAmount,
          reservation.user_id,
        ]);
      console.log(`チャージリセット: +${oldAmount}円`);
    }

    // ポイントをリセット（キャンセル以外の場合）
    if (reservation.status !== "キャンセル") {
      // 使用ポイントを返す
      if (oldUsePoint > 0) {
        await connection
          .promise()
          .query("UPDATE users SET point = point + ? WHERE id = ?", [
            oldUsePoint,
            reservation.user_id,
          ]);
        console.log(`使用ポイントリセット: +${oldUsePoint}P`);
      }

      // 付与ポイントを減らす
      if (oldAddPoint > 0) {
        await connection
          .promise()
          .query("UPDATE users SET point = point - ? WHERE id = ?", [
            oldAddPoint,
            reservation.user_id,
          ]);
        console.log(`付与ポイントリセット: -${oldAddPoint}P`);
      }
    }

    // ===== ステップ2: 新しい状態を適用 =====

    // チャージを適用（提供済の場合）
    if (status === "提供済") {
      await connection
        .promise()
        .query("UPDATE users SET charge = charge - ? WHERE id = ?", [
          newAmount,
          reservation.user_id,
        ]);
      console.log(`チャージ適用: -${newAmount}円`);

      await connection
        .promise()
        .query("UPDATE reservations SET is_charged = 1 WHERE id = ?", [editId]);
    } else {
      await connection
        .promise()
        .query("UPDATE reservations SET is_charged = 0 WHERE id = ?", [editId]);
    }

    // ポイントを適用（キャンセル以外の場合）
    if (status !== "キャンセル") {
      // 使用ポイントを減らす
      if (newUsePoint > 0) {
        await connection
          .promise()
          .query("UPDATE users SET point = point - ? WHERE id = ?", [
            newUsePoint,
            reservation.user_id,
          ]);
        console.log(`使用ポイント適用: -${newUsePoint}P`);
      }

      // 付与ポイントを追加
      if (newAddPoint > 0) {
        await connection
          .promise()
          .query("UPDATE users SET point = point + ? WHERE id = ?", [
            newAddPoint,
            reservation.user_id,
          ]);
        console.log(`付与ポイント適用: +${newAddPoint}P`);
      }
    }

    // ===== ステップ3: 予約情報を更新 =====

    const updateSql = `
      UPDATE reservations
      SET
        resource_id = ?,
        coupon_code = ?,
        use_point = ?,
        point = ?,
        reserve_day = ?,
        start_time = ?,
        usage_time = ?,
        amount = ?,
        status = ?,
        memo = ?,
        ticket = ?
      WHERE id = ?
    `;

    const updateParams = [
      Number(resource_id),
      coupon_code || null,
      newUsePoint,
      newAddPoint,
      reserve_day,
      start_time,
      Number(usage_time),
      newAmount,
      status,
      memo || "",
      editId,
      ticket ? Number(ticket) : 0,
    ];

    console.log("UPDATE パラメータ:", updateParams);

    await connection.promise().query(updateSql, updateParams);

    console.log("✅ 更新成功:", editId);
    res.redirect("/adminTop");
  } catch (err) {
    console.error("❌ 編集エラー:", err);
    res.status(500).send("Server Error");
  }
});

app.get("/adminCharge", (req, res) => {
  const id = req.session.userId;
  if (!id) return res.redirect("/");

  const updateTimeSql = "UPDATE users SET updated_at = NOW() WHERE id = ?";
  const loginUserSql = "SELECT * FROM users WHERE id = ?";
  const userListSql = "SELECT id, name FROM users ORDER BY name";

  connection.query(updateTimeSql, [id], (err) => {
    if (err) throw err;

    connection.query(loginUserSql, [id], (err, loginUserResults) => {
      if (err) throw err;
      const loginUser = loginUserResults[0];

      connection.query(userListSql, (err, userList) => {
        if (err) throw err;

        res.render("adminCharge", {
          users: loginUser, // ヘッダー・時間・権限判定用
          userList: userList, // ドロップダウン用
        });
      });
    });
  });
});

app.get("/admin/user-info/:id", (req, res) => {
  const userId = req.params.id;

  // 表示した時点で「確認時刻」を更新
  const updateSql = `
    UPDATE users
    SET updated_at = NOW()
    WHERE id = ?
  `;

  connection.query(updateSql, [userId], (err) => {
    if (err) return res.status(500).json({ error: err });

    const selectSql = `
      SELECT charge, point,ticket,
             DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
      FROM users
      WHERE id = ?
    `;

    connection.query(selectSql, [userId], (err, results) => {
      if (err) return res.status(500).json({ error: err });

      res.json(results[0]);
    });
  });
});

// 計画売上の取得API
app.get("/api/sales-target/:month", (req, res) => {
  const { month } = req.params;

  connection.query(
    "SELECT target_amount FROM sales_targets WHERE month = ?",
    [month],
    (error, results) => {
      if (error) {
        console.error(error);
        return res.status(500).json({ error: "Server Error" });
      }

      if (results.length === 0) {
        return res.json({ target_amount: 0 });
      }

      res.json({ target_amount: results[0].target_amount });
    },
  );
});

// 計画売上の保存API
app.post("/api/sales-target", (req, res) => {
  const { month, target_amount } = req.body;

  if (!month || target_amount === undefined) {
    return res.status(400).json({ error: "月と目標金額が必要です" });
  }

  connection.query(
    `
    INSERT INTO sales_targets (month, target_amount)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE target_amount = ?, updated_at = CURRENT_TIMESTAMP
    `,
    [month, target_amount, target_amount],
    (error) => {
      if (error) {
        console.error("DB保存エラー:", error);
        return res.status(500).json({ error: "Server Error" });
      }

      res.json({ success: true, message: "計画売上を保存しました" });
    },
  );
});

// sales_targetsテーブルの初期化
connection.query(
  `
  CREATE TABLE IF NOT EXISTS sales_targets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    month VARCHAR(7) NOT NULL UNIQUE,
    target_amount INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )
  `,
  (error) => {
    if (error) {
      console.error("sales_targets テーブル作成エラー:", error);
    }
  },
);

app.get("/stampCard", (req, res) => {
  connection.query("SELECT * FROM users", (error, results) => {
    if (error) throw error;
    res.render("stampCard", { users: results || [] });
  });
});

app.post("/stampCard", (req, res) => {});

app.listen(3000, "0.0.0.0", () => {
  console.log("Server running at http://0.0.0.0:3000");
  open("http://localhost:3000/");
});
