const jwt = require("jsonwebtoken");

class JwtService {

  static generateAccessToken(user) {
  return jwt.sign(
    {
      id: user.id,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
      email: user.email,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d",
    }
  );
}

  static generateRefreshToken(user) {
    return jwt.sign(
      {
        id: user.id,
        // PHASE E addition: role/tenantId let refreshToken() (and any
        // other refresh-token consumer) know WHICH database to check
        // without a second lookup by email. Purely additive — existing
        // refresh tokens issued before this change simply decode with
        // these fields undefined, handled as a legacy fallback.
        role: user.role,
        tenantId: user.tenantId,
        email: user.email,
        name: user.name,
      },
      process.env.JWT_REFRESH_SECRET,
      {
        expiresIn: "30d",
      }
    );
  }
}

module.exports = JwtService;