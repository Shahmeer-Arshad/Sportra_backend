import { PrismaClient } from '@prisma/client'
import { CreateUserInput, UpdateUserInput } from './user.schema'

export const createUserRepository = (prisma: PrismaClient) => ({
  findAll: async (skip: number, take: number) => {
    const [users, total] = await prisma.$transaction([
      prisma.user.findMany({
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          username: true,
          firstName: true,
          middleName: true,
          lastName: true,
          phone: true,
          profileUrl: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.user.count(),
    ])
    return { users, total }
  },

  findById: async (id: string) => {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        middleName: true,
        lastName: true,
        phone: true,
        profileUrl: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  },

  findByEmail: async (email: string) => {
    return prisma.user.findUnique({
      where: { email },
    })
  },

  findByUsername: async (username: string) => {
    return prisma.user.findUnique({
      where: { username },
    })
  },

  findByEmailExcludeId: async (email: string, id: string) => {
    return prisma.user.findFirst({
      where: { email, NOT: { id } },
    })
  },

  findByUsernameExcludeId: async (username: string, id: string) => {
    return prisma.user.findFirst({
      where: { username, NOT: { id } },
    })
  },

  create: async (data: CreateUserInput) => {
    return prisma.user.create({
      data: {
        email: data.email,
        username: data.username,
        firstName: data.firstName,
        middleName: data.middleName,
        lastName: data.lastName,
        phone: data.phone,
        profileUrl: data.profileUrl,
        password: data.password, 
        role: data.role,
      },
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        middleName: true,
        lastName: true,
        role: true,
        createdAt: true,
      },
    })
  },

  update: async (id: string, data: UpdateUserInput) => {
    return prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        middleName: true,
        lastName: true,
        role: true,
        updatedAt: true,
      },
    })
  },

  delete: async (id: string) => {
    await prisma.user.delete({ where: { id } })
  },

  // Refresh Token Methods
  saveRefreshToken: async (userId: string, jti: string, hashedToken: string, expiresAt: Date) => {
    return prisma.refreshToken.create({
      data: {
        userId,
        jti,
        hashedToken,
        expiresAt,
      },
    })
  },

  findRefreshToken: async (jti: string) => {
    return prisma.refreshToken.findUnique({
      where: { jti },
      include: { user: true },
    })
  },

  deleteRefreshToken: async (jti: string) => {
    return prisma.refreshToken.delete({
      where: { jti },
    })
  },

  deleteAllUserRefreshTokens: async (userId: string) => {
    return prisma.refreshToken.deleteMany({
      where: { userId },
    })
  },
})

export type UserRepository = ReturnType<typeof createUserRepository>
