import express from "express";
import session from "express-session";
import mysql from "mysql2";
const app = express();

import open from "open";
import path from "path";
import { fileURLToPath } from "url"; // 追加

const __filename = fileURLToPath(import.meta.url); // 追加
const __dirname = path.dirname(__filename); // 追加

const connection = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "reucloud1412",
  database: "reservation_system",
});

connection.connect((err) => {
  if (err) {
    console.error("MySQL接続エラー: ", err);
    return;
  }
  console.log("✅ MySQL connected!");
});

app.use(express.static(path.join(__dirname, "public"))); //CSS適応
app.use(express.urlencoded({ extended: true })); //ejsファイルから値を持って来れるようにする

app.use(
  session({
    secret: "secret-key",
    resave: false,
    saveUninitialized: true,
  })
);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// キャッシュ無効化
// 戻るボタン無効化
// app.use((req, res, next) => {
//   res.setHeader(
//     "Cache-Control",
//     "no-store, no-cache, must-revalidate, private"
//   );
//   next();
// });

app.get("/", (req, res) => {
  res.render("login");
});

app.get("/newUser", (req, res) => {
  res.render("newUser.ejs");
});

app.get("/forgetPassword", (req, res) => {
  res.render("forgetPassword.ejs");
});

app.get("/adminCoupons", (req, res) => {
  const id = req.session.userId;
  connection.query(
    "UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
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
            "SELECT * FROM coupons ORDER BY code ",
            (error, results) => {
              if (error) throw error;
              const coupons = results;
              res.render("adminCoupons", {
                users: user,
                coupons: coupons || [],
                id: id,
              });
            }
          );
        }
      );
    }
  );
});

app.post("/couponInput", (req, res) => {
  const couponName = req.body.name;
  const couponCode = req.body.code;
  const discountWay = req.body.type;
  const discount = req.body.discount;
  const filter = req.body.filter === "" ? null : req.body.filter;
  const start_date = req.body.start_date;
  const finish_date = req.body.finish_date;
  const couponPhoto = req.body.photo;
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
      res.redirect("/adminCoupons");
    }
  );
});

app.get("/adminCoupons/edit/:id", (req, res) => {
  const couponId = req.params.id;

  connection.query(
    "SELECT * FROM coupons WHERE id = ?",
    [couponId],
    (error, results) => {
      if (error) throw error;

      res.render("adminCouponEdit", {
        coupon: results[0],
      });
    }
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
      filter || null,
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

      // 更新後は一覧へ戻す
      res.redirect("/adminCoupons");
    }
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
    }
  );
});

app.get("/adminNews", (req, res) => {
  const id = req.session.userId;
  connection.query(
    "UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
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
            }
          );
        }
      );
    }
  );
});

app.get("/adminNews/edit/:id", (req, res) => {
  const newsId = req.params.id;

  connection.query(
    "SELECT * FROM news WHERE id = ?",
    [newsId],
    (error, results) => {
      if (error) throw error;

      res.render("adminNewsEdit", {
        news: results[0],
      });
    }
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
    }
  );
});

app.post("/adminNews/delete/:id", (req, res) => {
  const newsId = req.params.id;

  connection.query("DELETE FROM news WHERE id = ?", [newsId], (error) => {
    if (error) throw error;
    res.redirect("/adminNews");
  });
});

app.get("/charge", (req, res) => {
  const id = req.session.userId;
  connection.query(
    "UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [id],
    (error) => {
      if (error) throw error;
      connection.query(
        "SELECT * FROM users WHERE id = ?",
        [id],
        (error, results) => {
          if (error) throw error;
          const user = results[0];
          res.render("charge", {
            users: user,
            id: id,
          });
        }
      );
    }
  );
});

app.post("/charge", (req, res) => {
  const id = req.session.userId;
  const charge = Number(req.body.charge);

  connection.query(
    "UPDATE users SET charge =  charge + ? WHERE id = ?",
    [charge, id],
    (error, results) => {
      if (error) throw error;
      res.redirect("/charge");
    }
  );
});

app.get("/coupons", (req, res) => {
  const id = req.session.userId;
  connection.query(
    "UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
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
            "SELECT * FROM coupons ORDER BY code",
            (error, results) => {
              if (error) throw error;
              const coupons = results;
              res.render("coupons", {
                users: user,
                coupons: coupons || [],
                id: id,
              });
            }
          );
        }
      );
    }
  );
});

app.get("/top", (req, res) => {
  const id = req.session.userId;
  if (!id) return res.redirect("/"); // ログインしていなければ戻す

  // DB上の更新時間を更新
  connection.query(
    "UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
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
            (error, newsresults) => {
              if (error) throw error;
              const news = newsresults;
              connection.query(
                "SELECT * FROM reservations WHERE user_id = ?",
                [id],
                (error, reservations) => {
                  if (error) throw error;
                  const reserve = reservations;
                  res.render("top", {
                    users: user,
                    news: news || [],
                    reservation: reserve || [],
                    id: id,
                    couponError: false,
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

app.post("/login", (req, res) => {
  const mail = req.body.mail;
  const password = req.body.password;
  const errors = [];

  if (mail === "") {
    errors.push("メールアドレスが空欄です");
  }
  if (password === "") {
    errors.push("パスワード欄が空欄です");
  }

  connection.query(
    "SELECT * FROM users WHERE email = ?",
    [mail],
    (error, results) => {
      if (error) {
        return res.redirect("/");
      }

      if (results.length > 0 && password === results[0].password) {
        req.session.userId = results[0].id;
        res.redirect("/top");
      }
    }
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
        }
      );
    }
  );
});

app.post("/reservation", async (req, res) => {
  const id = req.session.userId;
  const { reserve_day, start_time, usage_time, coupon, memo } = req.body;
  const resource = req.body.resource === "massage" ? 1 : 2;
  const user_id = req.session.userId;
  const amount = await AmountCheck(resource, usage_time, coupon);
  connection.query(
    "UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [id],
    (error) => {
      if (error) throw error;
      if (amount === -1) {
        // クーポン無効の場合、EJS にフラグを渡して表示
        connection.query(
          "SELECT * FROM news ORDER BY create_at DESC",
          (error, newsresults) => {
            if (error) throw error;
            const news = newsresults;
            connection.query(
              "SELECT * FROM reservations WHERE user_id = ?",
              [user_id],
              (error, reservations) => {
                if (error) throw error;
                res.render("top", {
                  users: { id: user_id }, // 必要に応じて正しい user 情報を取得
                  news: news || [],
                  reservation: reservations || [],
                  id: user_id,
                  couponError: true, // ← ここでフラグ
                });
              }
            );
          }
        );
      } else {
        connection.query(
          "INSERT INTO reservations (user_id, reserve_day, start_time, usage_time, resource_id, coupon_code, memo, amount, status) VALUES (?,?,?,?,?,?,?,?,?)",
          [
            user_id,
            reserve_day,
            start_time,
            usage_time,
            resource,
            coupon,
            memo,
            amount,
            "承認前",
          ],
          (error) => {
            if (error) throw error;
            res.redirect("/top");
          }
        );
      }
    }
  );
});

async function AmountCheck(resource, usage_time, couponCode) {
  const [resourceRows] = await connection
    .promise()
    .query("SELECT id, name, price FROM resources WHERE id = ?", [resource]);

  if (resourceRows.length === 0) return 0;

  const { name, price } = resourceRows[0];
  let amount = price * (Number(usage_time) / 10);

  if (!couponCode) return Math.floor(amount);

  const [couponRows] = await connection
    .promise()
    .query("SELECT * FROM coupons WHERE code = ? AND is_open = 1", [
      couponCode,
    ]);

  if (couponRows.length === 0) return -1;

  const coupon = couponRows[0];

  const today = new Date();
  if (
    today < new Date(coupon.start_date) ||
    today > new Date(coupon.finish_date)
  ) {
    return Math.floor(amount);
  }

  const services = coupon.service.split(",");
  if (!services.includes(name)) return Math.floor(amount);

  if (coupon.type === "yen") amount -= coupon.discount;
  if (coupon.type === "percent") amount *= 1 - coupon.discount / 100;

  if (amount < 0) amount = 0;

  return Math.floor(amount);
}

app.get("/adminTop", (req, res) => {
  const id = req.session.userId;
  if (!id) return res.redirect("/"); // ログインしていなければ戻す

  // DB上の更新時間を更新
  connection.query(
    "UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
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
                "SELECT * FROM reservations WHERE user_id = ?",
                [id],
                (error, reservations) => {
                  if (error) throw error;
                  const reserve = reservations;
                  res.render("adminTop", {
                    users: user,
                    news: news || [],
                    reservation: reserve || [],
                    id: id,
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

app.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
  open("http://localhost:3000/");
});
